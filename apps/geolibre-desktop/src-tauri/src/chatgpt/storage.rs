//! Credentials belong to the native process; generic secure-store IPC cannot read them.
use super::{failure, Result, Vault};
use std::path::Path;

#[cfg(windows)]
fn protect(data: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::*};
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI binds this blob to the current Windows user, never machine-wide.
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(failure(
            "storage",
            "Windows could not protect or unlock the ChatGPT connection.",
        ));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        LocalFree(output.pbData as _);
    }
    Ok(bytes)
}

#[cfg(not(windows))]
fn protect(_: &[u8], _: bool) -> Result<Vec<u8>> {
    Err(failure(
        "unsupported",
        "ChatGPT subscription is available in the Windows desktop app.",
    ))
}

pub fn read(path: &Path) -> Result<Vault> {
    if !path.exists() {
        return Vault::new();
    }
    let blob = std::fs::read(path)
        .map_err(|_| failure("storage", "Could not read the saved ChatGPT connection."))?;
    let mut plain = protect(&blob, false)?;
    let result = serde_json::from_slice(&plain)
        .map_err(|_| failure("storage", "The saved ChatGPT connection is invalid."));
    plain.fill(0);
    result
}

pub fn write(path: &Path, vault: &Vault) -> Result<()> {
    let mut plain = serde_json::to_vec(vault)
        .map_err(|_| failure("storage", "Could not encode the ChatGPT connection."))?;
    let encrypted = protect(&plain, true);
    plain.fill(0);
    let encrypted = encrypted?;
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|_| failure("storage", "Could not create ChatGPT connection storage."))?;
    let temp = path.with_extension("tmp");
    use std::io::Write;
    let mut file = std::fs::File::create(&temp)
        .map_err(|_| failure("storage", "Could not save the ChatGPT connection."))?;
    file.write_all(&encrypted)
        .and_then(|_| file.sync_all())
        .map_err(|_| failure("storage", "Could not save the ChatGPT connection."))?;
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(failure(
                "storage",
                "Could not replace the saved ChatGPT connection.",
            ));
        }
    }
    #[cfg(not(windows))]
    return Err(failure("unsupported", "Windows desktop is required."));
    #[cfg(windows)]
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn dpapi_roundtrip_and_tamper() {
        let data = b"not-a-real-token";
        let mut blob = protect(data, true).unwrap();
        assert!(!blob.windows(data.len()).any(|w| w == data));
        assert_eq!(protect(&blob, false).unwrap(), data);
        let last = blob.len() - 1;
        blob[last] ^= 1;
        assert!(protect(&blob, false).is_err());
    }
    #[test]
    fn restart_and_signout_preserve_registration_but_remove_tokens() {
        let root = std::env::temp_dir().join(format!(
            "geolibre-auth-test-{}",
            super::super::auth::random(16).unwrap()
        ));
        let path = root.join("connection.dpapi");
        let mut vault = Vault::new().unwrap();
        vault.client_id = Some("test-registration".into());
        vault.tokens = Some(super::super::Tokens {
            access_token: "test-access".into(),
            refresh_token: "test-refresh".into(),
            id_token: "test-id".into(),
            expires_at: 0,
            scope: "".into(),
        });
        write(&path, &vault).unwrap();
        let mut loaded = read(&path).unwrap();
        assert_eq!(
            loaded.tokens.as_ref().unwrap().refresh_token,
            "test-refresh"
        );
        assert!(!loaded.tokens.as_ref().unwrap().permitted());
        loaded.tokens = None;
        write(&path, &loaded).unwrap();
        let signed_out = read(&path).unwrap();
        assert!(signed_out.tokens.is_none());
        assert_eq!(signed_out.client_id, vault.client_id);
        assert_eq!(signed_out.host_id, vault.host_id);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
