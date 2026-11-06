use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub fn random(bytes: usize) -> Result<String> {
    let mut value = vec![0; bytes];
    getrandom::fill(&mut value)
        .map_err(|_| failure("random", "Could not generate secure sign-in values."))?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

pub fn host_id() -> Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b)
        .map_err(|_| failure("random", "Could not create installation identity."))?;
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    let hex: String = b.iter().map(|v| format!("{v:02x}")).collect();
    Ok(format!(
        "urn:uuid:{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

pub fn auth_url(
    vault: &Vault,
    redirect: &str,
    state: &str,
    nonce: &str,
    verifier: &str,
    new_account: bool,
) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(&format!("{AUTH}/api/accounts/authorize")).unwrap();
    let client = if new_account {
        "dynamic_agent_client"
    } else {
        vault.client_id.as_deref().unwrap_or("dynamic_agent_client")
    };
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    {
        let mut q = url.query_pairs_mut();
        q.extend_pairs([
            ("client_id", client),
            ("ext_agent_host_id", &vault.host_id),
            ("response_type", "code"),
            ("redirect_uri", redirect),
            (
                "scope",
                "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            ),
            ("resource", API),
            ("state", state),
            ("nonce", nonce),
            ("code_challenge_method", "S256"),
            ("code_challenge", &challenge),
        ]);
        if client == "dynamic_agent_client" {
            q.append_pair("agent_name_hint", "GeoLibre");
        }
        if !new_account {
            if let Some(tokens) = &vault.tokens {
                q.append_pair("id_token_hint", &tokens.id_token);
            }
            if let Some(email) = &vault.email {
                q.append_pair("login_hint", email);
            }
            if vault.tokens.as_ref().is_some_and(|t| !t.permitted()) {
                q.append_pair("prompt", "consent");
            }
        }
    }
    Ok(url)
}

pub fn parse_callback(
    target: &str,
    state: &str,
    saved_client: Option<&str>,
) -> Result<(String, String)> {
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| failure("callback", "Invalid sign-in callback."))?;
    if url.path() != "/auth/callback" {
        return Err(failure("callback", "Unexpected callback path."));
    }
    let mut params = std::collections::HashMap::new();
    for (k, v) in url.query_pairs() {
        if params.insert(k.to_string(), v.to_string()).is_some() {
            return Err(failure("callback", "Duplicate sign-in parameters."));
        }
    }
    if params.get("state").map(String::as_str) != Some(state) {
        return Err(failure(
            "state",
            "Sign-in state did not match. Start again.",
        ));
    }
    if params.contains_key("error") {
        return Err(failure(
            "consent",
            "ChatGPT sign-in was declined. You can try again.",
        ));
    }
    let client = params
        .get("client_id")
        .map(String::as_str)
        .or(saved_client)
        .ok_or_else(|| failure("client", "ChatGPT did not complete client registration."))?;
    if client == "dynamic_agent_client"
        || client.is_empty()
        || saved_client.is_some_and(|s| s != client)
    {
        return Err(failure("client", "The sign-in client did not match."));
    }
    let code = params
        .get("code")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| failure("callback", "ChatGPT did not return an authorization code."))?;
    Ok((code.clone(), client.to_string()))
}

pub async fn callback(
    listener: tokio::net::TcpListener,
    state: &str,
    saved_client: Option<&str>,
) -> Result<(String, String)> {
    loop {
        let (mut socket, _) = listener
            .accept()
            .await
            .map_err(|_| failure("callback", "Could not receive the sign-in callback."))?;
        let request = tokio::time::timeout(Duration::from_secs(3), async {
            let mut bytes = Vec::new();
            let mut buf = [0u8; 1024];
            while bytes.len() < 16_384 {
                let n = socket.read(&mut buf).await.ok()?;
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buf[..n]);
                if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            String::from_utf8(bytes).ok()
        })
        .await
        .ok()
        .flatten();
        let result = request
            .as_deref()
            .and_then(|r| r.lines().next())
            .and_then(|r| r.strip_prefix("GET "))
            .and_then(|r| r.split_whitespace().next())
            .map(|target| parse_callback(target, state, saved_client));
        let valid = result
            .as_ref()
            .is_some_and(|r| r.is_ok() || r.as_ref().is_err_and(|e| e.code == "consent"));
        let response = if valid {
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nConnection: close\r\n\r\nReturn to GeoLibre to finish connecting."
        } else {
            "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nInvalid callback."
        };
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            socket.write_all(response.as_bytes()),
        )
        .await;
        if valid {
            return result.unwrap();
        }
    }
}

pub fn validate_id(
    token: &str,
    jwks: &Value,
    client: &str,
    nonce: &str,
    expected_subject: Option<&str>,
) -> Result<Value> {
    verify_id(token, jwks, client, Some(nonce), expected_subject)
}

pub fn validate_refresh_id(
    token: &str,
    jwks: &Value,
    client: &str,
    subject: Option<&str>,
) -> Result<Value> {
    verify_id(token, jwks, client, None, subject)
}

fn verify_id(
    token: &str,
    jwks: &Value,
    client: &str,
    nonce: Option<&str>,
    expected_subject: Option<&str>,
) -> Result<Value> {
    let bad = || {
        failure(
            "identity",
            "Could not verify the ChatGPT identity. Start sign-in again.",
        )
    };
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(bad());
    }
    let decode = |s: &str| URL_SAFE_NO_PAD.decode(s).map_err(|_| bad());
    let header: Value = serde_json::from_slice(&decode(parts[0])?).map_err(|_| bad())?;
    if header["alg"] != "RS256" {
        return Err(bad());
    }
    let kid = header["kid"].as_str().ok_or_else(bad)?;
    let key = jwks["keys"]
        .as_array()
        .and_then(|keys| {
            keys.iter().find(|k| {
                k["kid"] == kid
                    && k["kty"] == "RSA"
                    && k.get("use").is_none_or(|v| v == "sig")
                    && k.get("alg").is_none_or(|v| v == "RS256")
            })
        })
        .ok_or_else(bad)?;
    let n = decode(key["n"].as_str().ok_or_else(bad)?)?;
    let e = decode(key["e"].as_str().ok_or_else(bad)?)?;
    let signed = format!("{}.{}", parts[0], parts[1]);
    ring::signature::RsaPublicKeyComponents { n: &n, e: &e }
        .verify(
            &ring::signature::RSA_PKCS1_2048_8192_SHA256,
            signed.as_bytes(),
            &decode(parts[2])?,
        )
        .map_err(|_| bad())?;
    let claims: Value = serde_json::from_slice(&decode(parts[1])?).map_err(|_| bad())?;
    validate_claims_inner(&claims, client, nonce, expected_subject)?;
    Ok(claims)
}

fn validate_claims_inner(
    c: &Value,
    client: &str,
    nonce: Option<&str>,
    subject: Option<&str>,
) -> Result<()> {
    let audience = c["aud"].as_str() == Some(client)
        || c["aud"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == client));
    let now = now();
    if c["iss"] != AUTH
        || !audience
        || c["exp"].as_u64().is_none_or(|v| v <= now)
        || c["nbf"].as_u64().is_some_and(|v| v > now + 30)
        || nonce.is_some_and(|nonce| c["nonce"] != nonce)
        || c["sub"].as_str().is_none_or(str::is_empty)
        || subject.is_some_and(|s| c["sub"] != s)
        || c.get("azp").is_some_and(|v| v != client)
        || (c["aud"].as_array().is_some_and(|a| a.len() > 1) && c["azp"] != client)
    {
        return Err(failure(
            "identity",
            "The ChatGPT identity did not match this sign-in.",
        ));
    }
    Ok(())
}

pub async fn discovery(client: &reqwest::Client) -> Result<Value> {
    json_response(
        client
            .get(format!("{AUTH}/.well-known/openid-configuration"))
            .send()
            .await
            .map_err(network)?,
    )
    .await
}

pub fn endpoint(value: &Value, key: &str) -> Result<String> {
    let url = value[key]
        .as_str()
        .and_then(|s| reqwest::Url::parse(s).ok())
        .ok_or_else(|| failure("discovery", "OpenAI sign-in discovery is incomplete."))?;
    if url.scheme() != "https"
        || url.host_str() != Some("auth.openai.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(failure("discovery", "Unexpected OpenAI sign-in endpoint."));
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn validate_claims(c: &Value, client: &str, nonce: &str, subject: Option<&str>) -> Result<()> {
        validate_claims_inner(c, client, Some(nonce), subject)
    }
    #[test]
    fn signed_identity_is_verified_with_published_key() {
        // Synthetic test identity; the signing private key was never saved.
        let fixture: Value = serde_json::from_str(include_str!("test-identity.json")).unwrap();
        let token = fixture["token"].as_str().unwrap();
        assert!(validate_id(
            token,
            &fixture["jwks"],
            "test-client",
            "test-nonce",
            Some("test-user")
        )
        .is_ok());
        let mut parts: Vec<String> = token.split('.').map(String::from).collect();
        parts[1] = URL_SAFE_NO_PAD.encode(br#"{"sub":"attacker"}"#);
        assert!(validate_id(
            &parts.join("."),
            &fixture["jwks"],
            "test-client",
            "test-nonce",
            None
        )
        .is_err());
        assert!(validate_id(
            token,
            &json!({"keys":[]}),
            "test-client",
            "test-nonce",
            None
        )
        .is_err());
    }
    #[tokio::test]
    async fn callback_ignores_unrelated_requests_and_closes_listener() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let pending = tokio::spawn(async move { callback(listener, "expected", None).await });
        for target in [
            "/favicon.ico",
            "/auth/callback?state=wrong&code=c&client_id=a",
            "/auth/callback?state=expected&code=c&client_id=a",
        ] {
            let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
            socket
                .write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
                .await
                .unwrap();
            let mut response = Vec::new();
            socket.read_to_end(&mut response).await.unwrap();
        }
        assert_eq!(pending.await.unwrap().unwrap(), ("c".into(), "a".into()));
        assert!(tokio::net::TcpListener::bind(address).await.is_ok());
    }
    #[tokio::test]
    async fn timeout_and_cancellation_release_callback_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), callback(listener, "s", None))
                .await
                .is_err()
        );
        let listener = tokio::net::TcpListener::bind(address).await.unwrap();
        let state = ChatGptState::default();
        let rx = start_job(&state, "login").unwrap();
        stop_jobs(&state);
        assert!(cancellable(rx, callback(listener, "s", None))
            .await
            .is_err());
        assert!(tokio::net::TcpListener::bind(address).await.is_ok());
    }
    #[test]
    fn callbacks_are_bound_to_attempt_and_registration() {
        assert!(parse_callback(
            "/auth/callback?state=x&code=c&client_id=oaiapp_a",
            "x",
            None
        )
        .is_ok());
        assert!(parse_callback("/auth/callback?state=x&code=c", "x", Some("oaiapp_a")).is_ok());
        for target in [
            "/auth/callback?state=y&code=c&client_id=a",
            "/wrong?state=x&code=c&client_id=a",
            "/auth/callback?state=x&code=c",
            "/auth/callback?state=x&state=x&code=c&client_id=a",
            "/auth/callback?state=x&code=c&client_id=dynamic_agent_client",
        ] {
            assert!(parse_callback(target, "x", None).is_err());
        }
        assert!(
            parse_callback("/auth/callback?state=x&code=c&client_id=b", "x", Some("a")).is_err()
        );
        assert_eq!(
            parse_callback("/auth/callback?state=x&error=access_denied", "x", None)
                .unwrap_err()
                .code,
            "consent"
        );
    }
    #[test]
    fn identity_claims_and_signatures_fail_closed() {
        let c = json!({"iss":AUTH,"aud":"client","nonce":"nonce","sub":"user","exp":now()+300});
        assert!(validate_claims(&c, "client", "nonce", Some("user")).is_ok());
        for (key, v) in [
            ("iss", json!("https://evil.test")),
            ("aud", json!("other")),
            ("nonce", json!("wrong")),
            ("exp", json!(0)),
            ("sub", json!("other")),
        ] {
            let mut bad = c.clone();
            bad[key] = v;
            assert!(validate_claims(&bad, "client", "nonce", Some("user")).is_err());
        }
        assert!(validate_id(
            "eyJhbGciOiJub25lIn0.e30.",
            &json!({"keys":[]}),
            "client",
            "nonce",
            None
        )
        .is_err());
    }
    #[test]
    fn registration_and_reauthorization() {
        let mut vault = Vault::new().unwrap();
        let url = auth_url(
            &vault,
            "http://127.0.0.1:1234/auth/callback",
            "s",
            "n",
            "v",
            false,
        )
        .unwrap();
        assert!(url.as_str().contains("dynamic_agent_client"));
        vault.client_id = Some("oaiapp_saved".into());
        let url = auth_url(
            &vault,
            "http://127.0.0.1:4567/auth/callback",
            "s",
            "n",
            "v",
            false,
        )
        .unwrap();
        assert!(url.as_str().contains("oaiapp_saved"));
        assert!(!url.as_str().contains("agent_name_hint"));
    }
}
