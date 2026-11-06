//! Windows-only subscription transport. No command accepts endpoints or returns credentials.
mod auth;
mod sse;
mod storage;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{watch, Mutex as AsyncMutex};

const AUTH: &str = "https://auth.openai.com";
const API: &str = "https://api.openai.com/v1";
type Result<T> = std::result::Result<T, ConnectionError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionError {
    code: String,
    message: String,
    http_status: Option<u16>,
    request_id: Option<String>,
}
fn failure(code: &str, message: &str) -> ConnectionError {
    ConnectionError {
        code: code.into(),
        message: message.into(),
        http_status: None,
        request_id: None,
    }
}
fn network(_: reqwest::Error) -> ConnectionError {
    failure(
        "network",
        "Could not reach OpenAI. Check your connection and try again.",
    )
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    id_token: String,
    expires_at: u64,
    scope: String,
}
impl Tokens {
    fn permitted(&self) -> bool {
        self.scope
            .split_whitespace()
            .any(|s| s == "chatgpt.tokens.use.direct")
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Vault {
    host_id: String,
    client_id: Option<String>,
    subject: Option<String>,
    email: Option<String>,
    tokens: Option<Tokens>,
}
impl Vault {
    fn new() -> Result<Self> {
        Ok(Self {
            host_id: auth::host_id()?,
            client_id: None,
            subject: None,
            email: None,
            tokens: None,
        })
    }
}

#[derive(Default)]
pub struct ChatGptState {
    vault: AsyncMutex<Option<Vault>>,
    jobs: Mutex<HashMap<String, watch::Sender<bool>>>,
    epoch: AtomicU64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    supported: bool,
    connected: bool,
    permitted: bool,
    email: Option<String>,
    revision: u64,
}

fn path(app: &tauri::AppHandle) -> Result<PathBuf> {
    if !cfg!(windows) {
        return Err(failure(
            "unsupported",
            "ChatGPT subscription is available in the Windows desktop app.",
        ));
    }
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("chatgpt").join("connection.dpapi"))
        .map_err(|_| failure("storage", "Could not locate ChatGPT connection storage."))
}
fn load<'a>(app: &tauri::AppHandle, slot: &'a mut Option<Vault>) -> Result<&'a mut Vault> {
    if slot.is_none() {
        let file = path(app)?;
        let vault = storage::read(&file)?;
        storage::write(&file, &vault)?;
        *slot = Some(vault);
    }
    Ok(slot.as_mut().unwrap())
}
fn client() -> Result<reqwest::Client> {
    super::guarded_async_client_builder(reqwest::redirect::Policy::none())
        .map_err(|_| failure("network", "Could not initialize the OpenAI connection."))?
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(network)
}
fn changed(app: &tauri::AppHandle, state: &ChatGptState) {
    state.epoch.fetch_add(1, Ordering::SeqCst);
    let _ = app.emit("chatgpt-connection-changed", ());
}
fn start_job(state: &ChatGptState, id: &str) -> Result<watch::Receiver<bool>> {
    if id.is_empty() || id.len() > 100 {
        return Err(failure("request", "Invalid request identifier."));
    }
    let mut jobs = state.jobs.lock().unwrap();
    if jobs.contains_key(id) || jobs.len() >= 8 {
        return Err(failure(
            "busy",
            "A ChatGPT operation is already running. Try again shortly.",
        ));
    }
    let (tx, rx) = watch::channel(false);
    jobs.insert(id.into(), tx);
    Ok(rx)
}
fn stop_jobs(state: &ChatGptState) {
    for tx in state.jobs.lock().unwrap().values() {
        let _ = tx.send(true);
    }
}
async fn cancellable<T>(
    mut cancel: watch::Receiver<bool>,
    future: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    if *cancel.borrow() {
        return Err(failure("cancelled", "ChatGPT request cancelled."));
    }
    tokio::select! {
        biased;
        _ = cancel.changed() => Err(failure("cancelled", "ChatGPT request cancelled.")),
        result = future => result,
    }
}

pub(super) async fn json_response(response: reqwest::Response) -> Result<Value> {
    let status = response.status().as_u16();
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let body = read_limited(response, 2 * 1024 * 1024).await?;
    let value: Value = serde_json::from_slice(&body)
        .map_err(|_| failure("response", "OpenAI returned an unreadable response."))?;
    if !(200..300).contains(&status) {
        let mut error = service_error(&value);
        error.http_status = Some(status);
        error.request_id = request_id;
        if error.code == "service" {
            error.message = match status {
                401 => "ChatGPT authorization was rejected. Sign out and connect again.",
                403 => "This account or workspace is not eligible for this ChatGPT request.",
                429 => {
                    "The ChatGPT usage limit was reached. Review your usage in ChatGPT settings."
                }
                _ => "OpenAI could not complete the request. Try again later.",
            }
            .into();
        }
        return Err(error);
    }
    Ok(value)
}
async fn read_limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        if body.len() + chunk.len() > limit {
            return Err(failure(
                "response",
                "OpenAI response exceeded the size limit.",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
fn service_error(value: &Value) -> ConnectionError {
    let code = value
        .pointer("/error/code")
        .or_else(|| value.pointer("/response/error/code"))
        .or_else(|| value.get("error").filter(|v| v.is_string()))
        .or_else(|| value.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("service");
    let message = match code {
        "subscription_sharing_usage_limit_exceeded" => {
            "Your ChatGPT app usage limit was reached. Review your limits in ChatGPT settings."
        }
        "subscription_sharing_user_not_eligible" => {
            "This ChatGPT account or workspace is not eligible for subscription access."
        }
        "subscription_sharing_usage_unavailable" => {
            "OpenAI cannot check subscription usage right now. Try again later."
        }
        "subscription_sharing_unsupported_capability" => {
            "This model does not support the requested subscription capability."
        }
        "invalid_grant" => "ChatGPT authorization expired or was revoked. Connect again.",
        _ => "OpenAI could not complete this subscription request. Try again or reconnect.",
    };
    // Only a machine-readable code crosses IPC, never raw HTTP bodies or token errors.
    let safe_code =
        if code.len() < 100 && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            code
        } else {
            "service"
        };
    failure(safe_code, message)
}
fn token_set(value: &Value, previous: Option<&Tokens>) -> Result<Tokens> {
    let field = |name: &str| {
        value[name]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    if !value["token_type"]
        .as_str()
        .is_some_and(|v| v.eq_ignore_ascii_case("bearer"))
    {
        return Err(failure(
            "token",
            "OpenAI returned an unsupported token type.",
        ));
    }
    let tokens = Tokens {
        access_token: field("access_token")
            .ok_or_else(|| failure("token", "OpenAI did not return an access token."))?,
        refresh_token: field("refresh_token")
            .or_else(|| previous.map(|t| t.refresh_token.clone()))
            .ok_or_else(|| failure("token", "OpenAI did not grant renewable access."))?,
        id_token: field("id_token")
            .or_else(|| previous.map(|t| t.id_token.clone()))
            .ok_or_else(|| failure("token", "OpenAI did not return an identity token."))?,
        scope: field("scope")
            .or_else(|| previous.map(|t| t.scope.clone()))
            .unwrap_or_default(),
        expires_at: now().saturating_add(
            value["expires_in"]
                .as_u64()
                .filter(|v| *v > 0 && *v < 604800)
                .ok_or_else(|| failure("token", "OpenAI did not return a valid token lifetime."))?,
        ),
    };
    Ok(tokens)
}

#[tauri::command]
pub async fn chatgpt_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, ChatGptState>,
) -> Result<Status> {
    if !cfg!(windows) {
        return Ok(Status {
            supported: false,
            connected: false,
            permitted: false,
            email: None,
            revision: 0,
        });
    }
    let mut slot = state.vault.lock().await;
    let v = load(&app, &mut slot)?;
    Ok(Status {
        supported: true,
        connected: v.tokens.is_some(),
        permitted: v.tokens.as_ref().is_some_and(Tokens::permitted),
        email: v.email.clone(),
        revision: state.epoch.load(Ordering::SeqCst),
    })
}

#[tauri::command]
pub async fn chatgpt_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, ChatGptState>,
    new_account: bool,
) -> Result<()> {
    let cancel = start_job(&state, "login")?;
    let epoch = state.epoch.load(Ordering::SeqCst);
    let result = cancellable(cancel, async {
        let mut vault = {
            let mut slot = state.vault.lock().await;
            load(&app, &mut slot)?.clone()
        };
        if vault.tokens.as_ref().is_some_and(Tokens::permitted) {
            return Err(failure(
                "connected",
                "Sign out before connecting a different account.",
            ));
        }
        let old_client = if new_account {
            None
        } else {
            vault.client_id.clone()
        };
        let old_subject = if new_account {
            None
        } else {
            vault.subject.clone()
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| failure("listener", "Could not start the local sign-in listener."))?;
        let port = listener
            .local_addr()
            .map_err(|_| failure("listener", "Could not read the callback port."))?
            .port();
        let redirect = format!("http://127.0.0.1:{port}/auth/callback");
        let nonce = auth::random(32)?;
        let oauth_state = auth::random(32)?;
        let verifier = auth::random(32)?;
        let url = auth::auth_url(
            &vault,
            &redirect,
            &oauth_state,
            &nonce,
            &verifier,
            new_account,
        )?;
        app.opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|_| {
                failure(
                    "browser",
                    "Could not open your browser for ChatGPT sign-in.",
                )
            })?;
        let (code, client_id) = tokio::time::timeout(
            Duration::from_secs(300),
            auth::callback(listener, &oauth_state, old_client.as_deref()),
        )
        .await
        .map_err(|_| failure("timeout", "ChatGPT sign-in timed out. Try again."))??;
        let http = client()?;
        let value = json_response(
            http.post(format!("{AUTH}/api/accounts/oauth/token"))
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("client_id", &client_id),
                    ("code", &code),
                    ("code_verifier", &verifier),
                    ("redirect_uri", &redirect),
                    ("resource", API),
                ])
                .send()
                .await
                .map_err(network)?,
        )
        .await?;
        let tokens = token_set(&value, None)?;
        let discovery = auth::discovery(&http).await?;
        let jwks = json_response(
            http.get(auth::endpoint(&discovery, "jwks_uri")?)
                .send()
                .await
                .map_err(network)?,
        )
        .await?;
        let claims = auth::validate_id(
            &tokens.id_token,
            &jwks,
            &client_id,
            &nonce,
            old_subject.as_deref(),
        )?;
        vault.client_id = Some(client_id);
        vault.subject = claims["sub"].as_str().map(String::from);
        vault.email = claims["email"].as_str().map(String::from);
        vault.tokens = Some(tokens);
        let mut slot = state.vault.lock().await;
        if state.epoch.load(Ordering::SeqCst) != epoch {
            return Err(failure("cancelled", "Sign-in was cancelled."));
        }
        storage::write(&path(&app)?, &vault)?;
        *slot = Some(vault);
        changed(&app, &state);
        Ok(())
    })
    .await;
    state.jobs.lock().unwrap().remove("login");
    result
}

#[tauri::command]
pub fn chatgpt_cancel(state: tauri::State<'_, ChatGptState>, request_id: String) {
    if request_id == "login" {
        state.epoch.fetch_add(1, Ordering::SeqCst);
    }
    if let Some(tx) = state.jobs.lock().unwrap().get(&request_id) {
        let _ = tx.send(true);
    }
}

async fn finish_transaction<T: Send + 'static>(
    future: impl std::future::Future<Output = Result<T>> + Send + 'static,
) -> Result<T> {
    tokio::spawn(future)
        .await
        .map_err(|_| failure("connection", "Could not renew the ChatGPT connection."))?
}

async fn access(app: &tauri::AppHandle, _state: &ChatGptState) -> Result<String> {
    let app = app.clone();
    // A cancelled inference drops its waiter, not the rotating refresh transaction.
    // Sign-out waits on the same vault mutex and revokes the newest saved token.
    finish_transaction(async move {
        let state = app.state::<ChatGptState>();
        access_inner(&app, &state).await
    })
    .await
}

async fn access_inner(app: &tauri::AppHandle, state: &ChatGptState) -> Result<String> {
    // The mutex spans refresh and persistence: rotating refresh tokens are never raced.
    let mut slot = state.vault.lock().await;
    let vault = load(app, &mut slot)?;
    let tokens = vault.tokens.clone().ok_or_else(|| {
        failure(
            "disconnected",
            "Connect ChatGPT in Settings → AI Providers.",
        )
    })?;
    if !tokens.permitted() {
        return Err(failure(
            "permission",
            "Connect again and allow GeoLibre to use your ChatGPT plan.",
        ));
    }
    if tokens.expires_at > now() + 60 {
        return Ok(tokens.access_token);
    }
    let http = client()?;
    let value = json_response(
        http.post(format!("{AUTH}/api/accounts/oauth/token"))
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", vault.client_id.as_deref().unwrap_or("")),
                ("refresh_token", &tokens.refresh_token),
                ("resource", API),
            ])
            .send()
            .await
            .map_err(network)?,
    )
    .await?;
    let refreshed = token_set(&value, Some(&tokens))?;
    if value.get("id_token").is_some() {
        let discovery = auth::discovery(&http).await?;
        let jwks = json_response(
            http.get(auth::endpoint(&discovery, "jwks_uri")?)
                .send()
                .await
                .map_err(network)?,
        )
        .await?;
        auth::validate_refresh_id(
            &refreshed.id_token,
            &jwks,
            vault.client_id.as_deref().unwrap_or(""),
            vault.subject.as_deref(),
        )?;
    }
    if !refreshed.permitted() {
        return Err(failure(
            "permission",
            "ChatGPT plan permission is no longer available. Reconnect.",
        ));
    }
    let token = refreshed.access_token.clone();
    vault.tokens = Some(refreshed);
    storage::write(&path(app)?, vault)?;
    Ok(token)
}

#[tauri::command]
pub async fn chatgpt_sign_out(
    app: tauri::AppHandle,
    state: tauri::State<'_, ChatGptState>,
) -> Result<Value> {
    changed(&app, &state);
    stop_jobs(&state);
    let mut slot = state.vault.lock().await;
    let vault = load(&app, &mut slot)?;
    let old = vault.tokens.take();
    let saved = storage::write(&path(&app)?, vault);
    let mut revoked = old.is_none();
    if let Some(tokens) = old {
        if let Ok(http) = client() {
            let revoke = async {
                let info = auth::discovery(&http).await?;
                let url = auth::endpoint(&info, "revocation_endpoint")?;
                for attempt in 0..2 {
                    let response = http
                        .post(&url)
                        .form(&[
                            ("token", tokens.refresh_token.as_str()),
                            ("token_type_hint", "refresh_token"),
                            ("client_id", vault.client_id.as_deref().unwrap_or("")),
                        ])
                        .send()
                        .await;
                    if response.as_ref().is_ok_and(|r| r.status().as_u16() == 200) {
                        return Ok(true);
                    }
                    if response
                        .as_ref()
                        .is_ok_and(|r| r.status().is_client_error())
                    {
                        break;
                    }
                    if attempt == 0 {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
                Ok(false)
            };
            revoked = tokio::time::timeout(Duration::from_secs(12), revoke)
                .await
                .ok()
                .and_then(|r: Result<bool>| r.ok())
                .unwrap_or(false);
        }
    }
    changed(&app, &state);
    saved.map_err(|_| failure("storage", "Signed out for this session, but saved credentials could not be removed. Disconnect GeoLibre in ChatGPT settings before restarting."))?;
    Ok(json!({"revoked": revoked}))
}

#[tauri::command]
pub async fn chatgpt_models(
    app: tauri::AppHandle,
    state: tauri::State<'_, ChatGptState>,
) -> Result<Value> {
    let cancel = start_job(&state, "models")?;
    let result = cancellable(cancel, async {
        let token = access(&app, &state).await?;
        let value = json_response(
            client()?
                .get(format!("{API}/models"))
                .bearer_auth(token)
                .send()
                .await
                .map_err(network)?,
        )
        .await?;
        let models = value["models"].as_array().ok_or_else(|| {
            failure(
                "catalog",
                "OpenAI did not return a subscription model catalog.",
            )
        })?;
        Ok(Value::Array(
            models
                .iter()
                .filter(|v| v["visibility"] == "list")
                .filter_map(|v| {
                    Some(json!({"id": v["slug"].as_str()?, "name": v["display_name"].as_str()?}))
                })
                .collect(),
        ))
    })
    .await;
    state.jobs.lock().unwrap().remove("models");
    result
}

fn request_body(mut body: Value) -> Result<Value> {
    let object = body
        .as_object_mut()
        .ok_or_else(|| failure("request", "Invalid ChatGPT request."))?;
    const ALLOWED: &[&str] = &[
        "model",
        "input",
        "instructions",
        "tools",
        "tool_choice",
        "include",
        "store",
        "stream",
    ];
    if object.keys().any(|k| !ALLOWED.contains(&k.as_str()))
        || object
            .get("model")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || !object.get("input").is_some_and(Value::is_array)
    {
        return Err(failure("request", "Unsupported ChatGPT request fields."));
    }
    if let Some(tools) = object.get("tools") {
        let valid = tools.as_array().is_some_and(|tools| {
            tools.iter().all(|t| {
                t["type"] == "namespace"
                    && t["name"] == "geolibre"
                    && t["tools"]
                        .as_array()
                        .is_some_and(|items| items.iter().all(|t| t["type"] == "function"))
            })
        });
        if !valid {
            return Err(failure(
                "request",
                "Only GeoLibre function tools are supported.",
            ));
        }
    }
    object.insert("store".into(), json!(false));
    object.insert("stream".into(), json!(true));
    if serde_json::to_vec(&body).map_or(true, |b| b.len() > 16 * 1024 * 1024) {
        return Err(failure(
            "request",
            "This conversation is too large. Start a new conversation.",
        ));
    }
    Ok(body)
}

#[tauri::command]
pub async fn chatgpt_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, ChatGptState>,
    request_id: String,
    body: Value,
    on_event: tauri::ipc::Channel<Value>,
) -> Result<()> {
    let cancel = start_job(&state, &request_id)?;
    let result = cancellable(cancel, async {
        on_event
            .send(json!({"type":"geolibre.started"}))
            .map_err(|_| failure("cancelled", "The assistant panel was closed."))?;
        let body = request_body(body)?;
        let token = access(&app, &state).await?;
        let mut response = client()?
            .post(format!("{API}/responses"))
            .bearer_auth(token)
            .header("Content-Type", "application/json")
            .body(serde_json::to_vec(&body).unwrap())
            .send()
            .await
            .map_err(network)?;
        if !response.status().is_success() {
            json_response(response).await?;
            return Err(failure("response", "Unexpected response."));
        }
        let mut parser = sse::Parser::default();
        while let Some(chunk) = response.chunk().await.map_err(network)? {
            for event in parser.push(&chunk)? {
                match event["type"].as_str() {
                    Some("response.failed" | "error") => return Err(service_error(&event)),
                    Some("response.incomplete") => {
                        return Err(failure(
                            "incomplete",
                            "ChatGPT stopped before completing the response. Try again.",
                        ))
                    }
                    Some("response.completed") => {
                        on_event
                            .send(event)
                            .map_err(|_| failure("cancelled", "The assistant panel was closed."))?;
                        return Ok(());
                    }
                    _ => on_event
                        .send(event)
                        .map_err(|_| failure("cancelled", "The assistant panel was closed."))?,
                }
            }
        }
        Err(failure(
            "interrupted",
            "ChatGPT disconnected before completing the response. Try again.",
        ))
    })
    .await;
    state.jobs.lock().unwrap().remove(&request_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_contract_and_no_arbitrary_endpoints() {
        let b =
            request_body(json!({"model":"model","input":[],"store":true,"stream":false})).unwrap();
        assert_eq!(b["store"], false);
        assert_eq!(b["stream"], true);
        assert!(
            request_body(json!({"model":"m","input":[],"base_url":"https://evil.test"})).is_err()
        );
        assert!(
            request_body(json!({"model":"m","input":[],"tools":[{"type":"web_search"}]})).is_err()
        );
    }
    #[test]
    fn rotation_and_permission() {
        let old = Tokens {
            access_token: "old".into(),
            refresh_token: "r".into(),
            id_token: "i".into(),
            expires_at: 0,
            scope: "chatgpt.tokens.use.direct".into(),
        };
        let value = json!({"access_token":"new","token_type":"Bearer","expires_in":3600,"refresh_token":"rotated"});
        let next = token_set(&value, Some(&old)).unwrap();
        assert_eq!(next.refresh_token, "rotated");
        assert!(next.permitted());
        assert!(token_set(&value, None).is_err());
        assert_eq!(
            service_error(&json!({"error":"invalid_grant"})).code,
            "invalid_grant"
        );
    }
    #[tokio::test]
    async fn cancellation_prevents_late_completion() {
        let state = ChatGptState::default();
        let cancel = start_job(&state, "login").unwrap();
        assert!(start_job(&state, "login").is_err());
        stop_jobs(&state);
        let result = cancellable(cancel, async { Ok(()) }).await;
        assert_eq!(result.unwrap_err().code, "cancelled");
    }

    #[tokio::test]
    async fn cancelling_refresh_waiter_still_persists_rotation_before_signout() {
        use std::sync::Arc;
        let vault = Arc::new(AsyncMutex::new(Some("old")));
        let started = Arc::new(tokio::sync::Notify::new());
        let rotate = Arc::new(tokio::sync::Notify::new());
        let (v, s, r) = (vault.clone(), started.clone(), rotate.clone());
        let waiter = tokio::spawn(finish_transaction(async move {
            let mut token = v.lock().await;
            s.notify_one();
            r.notified().await;
            *token = Some("rotated");
            Ok(())
        }));
        started.notified().await;
        waiter.abort();
        rotate.notify_one();
        // Sign-out must observe and revoke the rotated token, then remove it.
        let mut token = vault.lock().await;
        assert_eq!(*token, Some("rotated"));
        *token = None;
        drop(token);
        assert_eq!(*vault.lock().await, None);
    }

    #[test]
    fn public_status_contains_no_credentials() {
        let status = serde_json::to_value(Status {
            supported: true,
            connected: true,
            permitted: true,
            email: Some("test@example.test".into()),
            revision: 1,
        })
        .unwrap();
        assert_eq!(status.as_object().unwrap().len(), 5);
        assert!(status.get("tokens").is_none());
    }
}
