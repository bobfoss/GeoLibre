//! User-installed Agent Skills. Packages are data until an approved script run.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

const FILE_LIMIT: u64 = 8 * 1024 * 1024;
const PACKAGE_LIMIT: u64 = 128 * 1024 * 1024;
const TEXT_LIMIT: u64 = 128 * 1024;
#[derive(Default)]
pub struct SkillState {
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    execution: Arc<Mutex<()>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    id: String,
    source: String,
    enabled: bool,
    digest: String,
    manifest: String,
    files: Vec<String>,
}
fn supported() -> Result<(), String> {
    if cfg!(all(windows, not(feature = "mas"))) {
        Ok(())
    } else {
        Err("Assistant skills require Windows desktop.".into())
    }
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    supported()?;
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("assistant-skills");
    fs::create_dir_all(path.join("packages")).map_err(|e| e.to_string())?;
    Ok(path)
}
fn identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("Invalid skill or session identifier.".into());
    }
    Ok(())
}
// Reject Windows device names, alternate data streams and ambiguous path spellings,
// including when tests run on Unix. Never follow links or junctions in packages.
fn relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty()
        || value.len() > 512
        || value.contains(['\\', ':', '\0'])
        || value.starts_with('/')
    {
        return Err("Expected a relative package path.".into());
    }
    for segment in value.split('/') {
        let stem = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.ends_with(['.', ' '])
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err("Unsafe package path.".into());
        }
    }
    let path = PathBuf::from(value);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Unsafe package path.".into());
    }
    Ok(path)
}
fn no_link(path: &Path) -> Result<fs::Metadata, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Links and junctions are not allowed in skills.".into());
        }
    }
    if meta.file_type().is_symlink() {
        return Err("Links are not allowed in skills.".into());
    }
    Ok(meta)
}
fn contained(base: &Path, value: &str) -> Result<PathBuf, String> {
    let rel = relative(value)?;
    no_link(base)?;
    let mut path = base.to_path_buf();
    for part in rel.components() {
        path.push(part);
        no_link(&path)?;
    }
    if !path
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(base.canonicalize().map_err(|e| e.to_string())?)
    {
        return Err("Path leaves the skill directory.".into());
    }
    Ok(path)
}
fn scan(
    base: &Path,
    directory: &Path,
    files: &mut Vec<String>,
    total: &mut u64,
) -> Result<(), String> {
    no_link(directory)?;
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let meta = no_link(&path)?;
        let rel = path
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        relative(&rel)?;
        if rel
            .split('/')
            .any(|s| matches!(s, ".git" | "__pycache__" | ".venv"))
        {
            continue;
        }
        if meta.is_dir() {
            scan(base, &path, files, total)?;
        } else if meta.is_file() {
            *total += meta.len();
            if meta.len() > FILE_LIMIT || *total > PACKAGE_LIMIT || files.len() >= 3000 {
                return Err("Skill exceeds the package size or file count limit.".into());
            }
            files.push(rel);
        } else {
            return Err("Only regular files are allowed in skills.".into());
        }
    }
    Ok(())
}
fn fingerprint(base: &Path, files: &[String]) -> Result<String, String> {
    let mut hash = Sha256::new();
    for file in files {
        hash.update(file.as_bytes());
        hash.update([0]);
        let path = contained(base, file)?;
        let bytes = bounded_read(&path, FILE_LIMIT)?;
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}
fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("File exceeds the read limit.".into());
    }
    Ok(bytes)
}
fn load(root: &Path, id: &str) -> Result<InstalledSkill, String> {
    identifier(id)?;
    serde_json::from_slice(&bounded_read(
        &contained(&root.join("packages"), &format!("{id}/metadata.json"))?,
        TEXT_LIMIT * 4,
    )?)
    .map_err(|e| e.to_string())
}
fn enabled(root: &Path, id: &str) -> Result<InstalledSkill, String> {
    let skill = load(root, id)?;
    if !skill.enabled {
        return Err("Skill is disabled. Enable it in Settings → AI Providers → Skills.".into());
    }
    Ok(skill)
}
#[tauri::command]
pub fn assistant_skills_list(app: tauri::AppHandle) -> Result<Vec<InstalledSkill>, String> {
    let root = root(&app)?;
    let mut result = Vec::new();
    for entry in fs::read_dir(root.join("packages")).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if id.starts_with("staging-") {
            continue;
        }
        match load(&root, &id) {
            Ok(skill) => result.push(skill),
            Err(error) => result.push(InstalledSkill {
                id,
                source: format!("Unreadable package metadata: {error}"),
                enabled: false,
                digest: String::new(),
                manifest: String::new(),
                files: Vec::new(),
            }),
        }
    }
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(result)
}
#[tauri::command]
pub fn assistant_skill_enable(
    app: tauri::AppHandle,
    state: tauri::State<'_, SkillState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let root = root(&app)?;
    let mut skill = load(&root, &id)?;
    skill.enabled = enabled;
    if !enabled {
        for cancel in state.jobs.lock().map_err(|e| e.to_string())?.values() {
            cancel.store(true, Ordering::SeqCst);
        }
    }
    let dir = root.join("packages").join(id);
    let bytes = serde_json::to_vec(&skill).map_err(|e| e.to_string())?;
    let temp = dir.join(format!("metadata-{}.tmp", random_id()?));
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(temp, dir.join("metadata.json")).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn assistant_skill_remove(
    app: tauri::AppHandle,
    state: tauri::State<'_, SkillState>,
    id: String,
) -> Result<(), String> {
    let root = root(&app)?;
    identifier(&id)?;
    for cancel in state.jobs.lock().map_err(|e| e.to_string())?.values() {
        cancel.store(true, Ordering::SeqCst);
    }
    fs::remove_dir_all(contained(&root.join("packages"), &id)?).map_err(|e| e.to_string())
}
fn install(root: &Path, source: &Path, provenance: String) -> Result<InstalledSkill, String> {
    let mut files = Vec::new();
    scan(source, source, &mut files, &mut 0)?;
    files.sort();
    if !files.iter().any(|f| f == "SKILL.md") {
        return Err("Select the folder containing SKILL.md.".into());
    }
    let manifest = String::from_utf8(bounded_read(&source.join("SKILL.md"), TEXT_LIMIT)?)
        .map_err(|_| "SKILL.md must be UTF-8.")?;
    if !manifest.trim_start_matches('\u{feff}').starts_with("---")
        || !manifest.lines().any(|l| l.starts_with("name:"))
        || !manifest.lines().any(|l| l.starts_with("description:"))
    {
        return Err("SKILL.md needs frontmatter with name and description.".into());
    }
    let digest = fingerprint(source, &files)?;
    let id = digest[..24].to_owned();
    let target = root.join("packages").join(&id);
    if target.exists() {
        return Err("This exact skill is already installed.".into());
    }
    let staging = root.join("packages").join(format!("staging-{id}"));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        let package = staging.join("package");
        fs::create_dir(&package).map_err(|e| e.to_string())?;
        for file in &files {
            let dest = package.join(relative(file)?);
            fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::write(dest, bounded_read(&contained(source, file)?, FILE_LIMIT)?)
                .map_err(|e| e.to_string())?;
        }
        if fingerprint(&package, &files)? != digest {
            return Err("Skill changed during import. Try again.".into());
        }
        let skill = InstalledSkill {
            id,
            source: provenance,
            enabled: false,
            digest,
            manifest,
            files,
        };
        fs::write(
            staging.join("metadata.json"),
            serde_json::to_vec(&skill).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(&staging, &target).map_err(|e| e.to_string())?;
        Ok(skill)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}
fn github_parts(value: &str) -> Result<(String, String), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Enter a public GitHub repository URL.")?;
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || parts.len() != 2
    {
        return Err("Use https://github.com/owner/repository (public repositories only).".into());
    }
    for part in &parts {
        if part.is_empty()
            || !part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        {
            return Err("Invalid repository URL.".into());
        }
    }
    Ok((parts[0].into(), parts[1].trim_end_matches(".git").into()))
}
fn github_install(root: &Path, url: &str, folder: &str) -> Result<InstalledSkill, String> {
    let (owner, repo) = github_parts(url)?;
    let client = reqwest::blocking::Client::builder()
        .user_agent("GeoLibre-skills")
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let metadata = client
        .get(format!(
            "https://api.github.com/repos/{owner}/{repo}/commits?per_page=1"
        ))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("GitHub download failed: {e}"))?
        .text()
        .map_err(|e| e.to_string())?;
    let commits: serde_json::Value = serde_json::from_str(&metadata).map_err(|e| e.to_string())?;
    let sha = commits[0]["sha"]
        .as_str()
        .filter(|s| s.len() == 40 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("GitHub did not return a commit.")?;
    let mut bytes = Vec::new();
    client
        .get(format!(
            "https://codeload.github.com/{owner}/{repo}/zip/{sha}"
        ))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(
            "Repository archive exceeds 64 MB. Import a local skill folder instead.".into(),
        );
    }
    let staging = root.join(format!("download-{}", random_id()?));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut zip =
            zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
        let mut candidates = Vec::new();
        for index in 0..zip.len() {
            let file = zip.by_index(index).map_err(|e| e.to_string())?;
            let name = file.name().map_err(|e| e.to_string())?;
            if name.ends_with("/SKILL.md") {
                candidates.push(name.trim_end_matches("SKILL.md").to_string());
            }
        }
        let prefix = if folder.trim().is_empty() {
            if candidates.len() != 1 {
                return Err("Repository has multiple or no skills. Enter the folder containing SKILL.md (for example skills/my-skill).".into());
            }
            candidates.remove(0)
        } else {
            relative(folder)?;
            candidates
                .into_iter()
                .find(|p| {
                    p.split_once('/')
                        .map(|(_, tail)| tail.trim_end_matches('/') == folder)
                        .unwrap_or(false)
                })
                .ok_or("No SKILL.md in that repository folder.")?
        };
        let mut total = 0;
        let mut count = 0;
        let mut names = std::collections::HashSet::new();
        for index in 0..zip.len() {
            let mut file = zip.by_index(index).map_err(|e| e.to_string())?;
            let file_name = file.name().map_err(|e| e.to_string())?.into_owned();
            let Some(name) = file_name.strip_prefix(&prefix) else {
                continue;
            };
            if name.is_empty() || file.is_dir() {
                continue;
            }
            let rel = relative(name)?;
            if !names.insert(name.to_ascii_lowercase())
                || file
                    .unix_mode()
                    .map(|m| m & 0o170000 == 0o120000)
                    .unwrap_or(false)
            {
                return Err("Archive contains duplicate paths or links.".into());
            }
            total += file.size();
            count += 1;
            if file.size() > FILE_LIMIT || total > PACKAGE_LIMIT || count > 3000 {
                return Err("Skill archive exceeds limits.".into());
            }
            let dest = staging.join(rel);
            fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut output = fs::File::create(dest).map_err(|e| e.to_string())?;
            let copied = std::io::copy(&mut (&mut file).take(FILE_LIMIT + 1), &mut output)
                .map_err(|e| e.to_string())?;
            if copied > FILE_LIMIT {
                return Err("Archive file exceeds limits.".into());
            }
        }
        install(
            root,
            &staging,
            format!(
                "https://github.com/{owner}/{repo}/tree/{sha}/{}",
                prefix.split_once('/').unwrap().1
            ),
        )
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}
#[tauri::command]
pub async fn assistant_skill_import(
    app: tauri::AppHandle,
    source: String,
    folder: String,
) -> Result<InstalledSkill, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if source.starts_with("https://") {
            github_install(&root, &source, &folder)
        } else {
            install(&root, Path::new(&source), source.clone())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn workspace(root: &Path, session: &str) -> Result<PathBuf, String> {
    identifier(session)?;
    let dir = root.join("work").join(session);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    no_link(&dir)?;
    Ok(dir)
}
#[tauri::command]
pub fn assistant_skill_read(
    app: tauri::AppHandle,
    id: String,
    session: String,
    path: String,
    output: bool,
) -> Result<serde_json::Value, String> {
    let root = root(&app)?;
    enabled(&root, &id)?;
    let base = if output {
        workspace(&root, &session)?
    } else {
        root.join("packages").join(&id).join("package")
    };
    let path = if path == "." {
        no_link(&base)?;
        base
    } else {
        contained(&base, &path)?
    };
    if path.is_dir() {
        let names: Result<Vec<_>, _> = fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .take(500)
            .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect();
        return Ok(serde_json::json!({"files": names.map_err(|e| e.to_string())?}));
    }
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        let bytes = bounded_read(&path, 4 * 1024 * 1024)?;
        return Ok(
            serde_json::json!({"format": if extension == "jpg" { "jpeg" } else { &extension }, "base64": STANDARD.encode(bytes)}),
        );
    }
    Ok(
        serde_json::json!({"text": String::from_utf8(bounded_read(&path, TEXT_LIMIT)?).map_err(|_| "File is not UTF-8 text or a supported image.")?}),
    )
}
#[tauri::command]
pub fn assistant_skill_attach(
    app: tauri::AppHandle,
    state: tauri::State<'_, SkillState>,
    session: String,
    name: String,
    base64: String,
) -> Result<String, String> {
    let root = root(&app)?;
    let jobs = state.jobs.lock().map_err(|e| e.to_string())?;
    if jobs
        .get(&session)
        .map(|c| c.load(Ordering::SeqCst))
        .unwrap_or(false)
    {
        return Err("Skill session cancelled.".into());
    }
    relative(&name)?;
    if name.contains('/') || base64.len() > 6 * 1024 * 1024 {
        return Err("Invalid skill attachment.".into());
    }
    let bytes = STANDARD.decode(base64).map_err(|e| e.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Attachment exceeds 4 MB.".into());
    }
    let file = workspace(&root, &session)?.join(&name);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(file)
        .map_err(|e| e.to_string())?
        .write_all(&bytes)
        .map_err(|e| e.to_string())?;
    Ok(name)
}
#[tauri::command]
pub fn assistant_skill_cancel(
    app: tauri::AppHandle,
    state: tauri::State<'_, SkillState>,
    session: String,
) -> Result<(), String> {
    identifier(&session)?;
    let mut jobs = state.jobs.lock().map_err(|e| e.to_string())?;
    jobs.entry(session.clone())
        .or_default()
        .store(true, Ordering::SeqCst);
    // A running process may still hold its log open; run() retries after reaping it.
    let work = root(&app)?.join("work").join(session);
    if work.exists() {
        no_link(&work)?;
        let _ = fs::remove_dir_all(work);
    }
    Ok(())
}
#[tauri::command]
pub async fn assistant_skill_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, SkillState>,
    id: String,
    session: String,
    script: String,
    args: Vec<String>,
) -> Result<serde_json::Value, String> {
    let root = root(&app)?;
    identifier(&session)?;
    if args.len() > 100 || args.iter().any(|a| a.len() > 8192 || a.contains('\0')) {
        return Err("Too many or invalid script arguments.".into());
    }
    let cancelled = state
        .jobs
        .lock()
        .map_err(|e| e.to_string())?
        .entry(session.clone())
        .or_default()
        .clone();
    let execution = state.execution.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = execution.lock().map_err(|e| e.to_string())?;
        let result = run(
            &app,
            &root,
            &id,
            &session,
            &script,
            &args,
            cancelled.clone(),
        );
        if cancelled.load(Ordering::SeqCst) {
            let _ = fs::remove_dir_all(root.join("work").join(&session));
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(windows)]
struct ProcessJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl ProcessJob {
    fn attach(child: &std::process::Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err("Could not create a cancellable skill process group.".into());
            }
            let job = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle() as _) == 0
            {
                return Err("Could not attach the skill to its cancellation group.".into());
            }
            Ok(job)
        }
    }
    fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(not(feature = "mas"))]
fn run(
    app: &tauri::AppHandle,
    root: &Path,
    id: &str,
    session: &str,
    script: &str,
    args: &[String],
    cancelled: Arc<AtomicBool>,
) -> Result<serde_json::Value, String> {
    let skill = enabled(root, id)?;
    if !script.starts_with("scripts/")
        || !script.ends_with(".py")
        || !skill.files.iter().any(|f| f == script)
    {
        return Err("Select an installed Python file under scripts/.".into());
    }
    let package = root.join("packages").join(id).join("package");
    let mut actual_files = Vec::new();
    scan(&package, &package, &mut actual_files, &mut 0)?;
    actual_files.sort();
    if actual_files != skill.files || fingerprint(&package, &skill.files)? != skill.digest {
        return Err(
            "Installed skill changed. Remove and import it again before running scripts.".into(),
        );
    }
    if cancelled.load(Ordering::SeqCst) {
        return Err("Skill run cancelled.".into());
    }
    let uv = crate::ensure_managed_uv(app)?;
    let runtime = crate::app_runtime_dir(app)?;
    let work = workspace(root, session)?;
    let output = work.join(format!("run-{}.log", random_id()?));
    let stdout = fs::File::create(&output).map_err(|e| e.to_string())?;
    let mut command = std::process::Command::new(uv);
    let expanded: Vec<_> = args
        .iter()
        .map(|arg| {
            arg.replace("${SKILL_DIR}", &package.to_string_lossy())
                .replace("${CLAUDE_SKILL_DIR}", &package.to_string_lossy())
        })
        .collect();
    command
        .args(["run", "--no-project", "--python", "3.12", "--script"])
        .arg(contained(&package, script)?)
        .args(expanded)
        .current_dir(&work)
        .env("CLAUDE_SKILL_DIR", &package)
        .env("SKILL_DIR", &package)
        .env("UV_CACHE_DIR", runtime.join("uv-cache"))
        .env("UV_PYTHON_INSTALL_DIR", runtime.join("uv-python"))
        .env("PYTHONUTF8", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONPYCACHEPREFIX", work.join("pycache"))
        .stdin(std::process::Stdio::null())
        .stdout(stdout.try_clone().map_err(|e| e.to_string())?)
        .stderr(stdout);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    if cancelled.load(Ordering::SeqCst) {
        return Err("Skill run cancelled.".into());
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start skill Python runtime: {e}"))?;
    #[cfg(windows)]
    let job = match ProcessJob::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let start = Instant::now();
    let (status, reason) = loop {
        let reason = if cancelled.load(Ordering::SeqCst) {
            Some("Cancelled")
        } else if start.elapsed() > Duration::from_secs(900) {
            Some("Timed out after 15 minutes")
        } else if fs::metadata(&output)
            .map(|m| m.len() > 1024 * 1024)
            .unwrap_or(false)
        {
            Some("Output exceeded 1 MB")
        } else {
            None
        };
        if let Some(reason) = reason {
            #[cfg(windows)]
            job.terminate();
            let _ = child.kill();
            break (child.wait().map_err(|e| e.to_string())?, Some(reason));
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break (status, None);
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    #[cfg(windows)]
    drop(job); // Reap descendants even if a script tried to leave background work running.
    let mut bytes = Vec::new();
    fs::File::open(&output)
        .map_err(|e| e.to_string())?
        .take(TEXT_LIMIT)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let result = serde_json::json!({"success": status.success() && reason.is_none(), "exitCode": status.code(), "reason": reason, "text": text, "outputTruncated": fs::metadata(&output).map(|m| m.len() > TEXT_LIMIT).unwrap_or(false), "outputFile": output.file_name().unwrap().to_string_lossy(), "workspace": work, "skillDirectory": package});
    if cancelled.load(Ordering::SeqCst) {
        let _ = fs::remove_dir_all(&work);
    }
    Ok(result)
}
/// Discard attachment/output files from a previous app lifetime, including crashes.
pub fn clear_old_work(app: &tauri::AppHandle) -> Result<(), String> {
    if !cfg!(all(windows, not(feature = "mas"))) {
        return Ok(());
    }
    let work = root(app)?.join("work");
    if work.exists() {
        no_link(&work)?;
        fs::remove_dir_all(work).map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[cfg(feature = "mas")]
fn run(
    _: &tauri::AppHandle,
    _: &Path,
    _: &str,
    _: &str,
    _: &str,
    _: &[String],
    _: Arc<AtomicBool>,
) -> Result<serde_json::Value, String> {
    Err("Skill execution is unavailable in this build.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Downloads a user-selected public package; set GEOLIBRE_SKILL_SMOKE_SOURCE and GEOLIBRE_SKILL_SMOKE_ROOT"]
    fn import_public_repository() {
        let source = std::env::var("GEOLIBRE_SKILL_SMOKE_SOURCE").expect("Set source URL");
        let root = PathBuf::from(
            std::env::var("GEOLIBRE_SKILL_SMOKE_ROOT").expect("Set new test library directory"),
        );
        assert!(!root.exists(), "Use a new directory for each smoke test");
        fs::create_dir_all(root.join("packages")).unwrap();
        let folder = std::env::var("GEOLIBRE_SKILL_SMOKE_FOLDER").unwrap_or_default();
        let skill = github_install(&root, &source, &folder).unwrap();
        assert!(!skill.enabled);
        assert!(skill.files.iter().any(|p| p == "SKILL.md"));
        println!(
            "Imported {} files at {} from {}",
            skill.files.len(),
            root.join("packages").join(&skill.id).display(),
            skill.source
        );
    }
    #[test]
    #[cfg(windows)]
    fn process_group_can_be_cancelled() {
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .creation_flags(0x08000000)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let group = ProcessJob::attach(&child).unwrap();
        group.terminate();
        assert!(!child.wait().unwrap().success());
    }
    #[test]
    fn rejects_traversal_devices_and_alternate_streams() {
        for path in [
            "../secret",
            "/etc/passwd",
            "C:/secret",
            "a\\b",
            "a/../b",
            "a//b",
            "a:stream",
            "CON.py",
            "a/LPT1.txt",
            "a. /b",
            "a.",
        ] {
            assert!(relative(path).is_err(), "{path}");
        }
        assert!(relative("references/sky.md").is_ok());
    }
    #[test]
    fn accepts_only_public_github_repository_urls() {
        assert_eq!(
            github_parts("https://github.com/Oldcircle/geo-sleuth").unwrap(),
            ("Oldcircle".into(), "geo-sleuth".into())
        );
        for url in [
            "http://github.com/a/b",
            "https://evil.test/a/b",
            "https://user@github.com/a/b",
            "https://github.com/a/b?x=1",
            "https://github.com/a/b/tree/main",
        ] {
            assert!(github_parts(url).is_err());
        }
    }
    #[test]
    fn install_is_disabled_immutable_and_complete() {
        let temp =
            std::env::temp_dir().join(format!("geolibre-skill-test-{}", random_id().unwrap()));
        let source = temp.join("source");
        let root = temp.join("library");
        fs::create_dir_all(source.join("scripts")).unwrap();
        fs::create_dir_all(root.join("packages")).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: test\ndescription: Test skill\n---\nInstructions",
        )
        .unwrap();
        fs::write(source.join("scripts/check.py"), "print('ok')").unwrap();
        let installed = install(&root, &source, "local".into()).unwrap();
        assert!(!installed.enabled);
        assert_eq!(installed.files.len(), 2);
        assert!(enabled(&root, &installed.id).is_err());
        assert!(install(&root, &source, "local".into()).is_err());
        let package = root.join("packages").join(&installed.id).join("package");
        fs::write(package.join("scripts/check.py"), "print('changed')").unwrap();
        assert_ne!(
            fingerprint(&package, &installed.files).unwrap(),
            installed.digest
        );
        fs::remove_dir_all(temp).unwrap();
    }
}
