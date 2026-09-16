use axum::{extract::Query, response::IntoResponse, routing::get, Extension, Router};
use log::{error, info};
use oauth2::{
    basic::BasicClient, reqwest::async_http_client, AuthUrl, AuthorizationCode, ClientId,
    CsrfToken, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope, TokenResponse, TokenUrl,
};
use serde::Deserialize;
use std::{
    net::{SocketAddr, TcpListener},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::{error::Error, AppState};

fn create_client(redirect_url: RedirectUrl) -> BasicClient {
    let client_id = ClientId::new("org.encroissant.app".to_string());
    let auth_url = AuthUrl::new("https://lichess.org/oauth".to_string());
    let token_url = TokenUrl::new("https://lichess.org/api/token".to_string());

    BasicClient::new(client_id, None, auth_url.unwrap(), token_url.ok())
        .set_redirect_uri(redirect_url)
}

fn get_available_addr() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);

    addr
}

#[derive(Clone)]
pub struct AuthState {
    pub csrf_token: CsrfToken,
    pub pkce: Arc<(PkceCodeChallenge, String)>,
    pub client: Arc<BasicClient>,
    pub socket_addr: SocketAddr,
    /// Guards against a second `authenticate()` call trying to bind the same
    /// callback socket while a previous OAuth flow is still being served.
    /// Cleared once the callback server has fully shut down.
    pub authenticating: Arc<AtomicBool>,
}

impl Default for AuthState {
    fn default() -> Self {
        let (pkce_code_challenge, pkce_code_verifier) = PkceCodeChallenge::new_random_sha256();
        let socket_addr = get_available_addr();
        let redirect_url = format!("http://{socket_addr}/callback");
        AuthState {
            csrf_token: CsrfToken::new_random(),
            pkce: Arc::new((
                pkce_code_challenge,
                PkceCodeVerifier::secret(&pkce_code_verifier).to_string(),
            )),
            client: Arc::new(create_client(RedirectUrl::new(redirect_url).unwrap())),
            socket_addr,
            authenticating: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn authenticate(
    username: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), Error> {
    info!("Authenticating user {}", username);

    // Only one OAuth callback server can be bound (and listening) at a time,
    // since it reuses the socket address generated once at startup. If a
    // previous flow is still in progress, tell the caller instead of letting
    // a second `axum::Server::bind` panic on an address already in use.
    if state
        .auth
        .authenticating
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(Error::AlreadyAuthenticating);
    }

    let (auth_url, _) = state
        .auth
        .client
        .authorize_url(|| state.auth.csrf_token.clone())
        .add_scope(Scope::new("preference:read".to_string()))
        .add_extra_param("username", username)
        .set_pkce_challenge(state.auth.pkce.0.clone())
        .url();

    if let Err(err) = app.opener().open_url(auth_url.as_str(), None::<&str>) {
        // We never started the server, so release the guard immediately.
        state.auth.authenticating.store(false, Ordering::SeqCst);
        return Err(err.into());
    }

    let _server_handle = tauri::async_runtime::spawn(async move { run_server(app).await });
    Ok(())
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: AuthorizationCode,
    state: CsrfToken,
}

type ShutdownSender = Arc<Mutex<Option<oneshot::Sender<()>>>>;

async fn authorize(
    app: Extension<tauri::AppHandle>,
    query: Query<CallbackQuery>,
    Extension(shutdown_tx): Extension<ShutdownSender>,
) -> impl IntoResponse {
    let auth = &app.state::<AppState>().auth;

    if query.state.secret() != auth.csrf_token.secret() {
        println!("Suspected Man in the Middle attack!");
        // never let them know your next move
    } else {
        match auth
            .client
            .exchange_code(query.code.clone())
            .set_pkce_verifier(PkceCodeVerifier::new(auth.pkce.1.clone()))
            .request_async(async_http_client)
            .await
        {
            Ok(token) => {
                let access_token = token.access_token().secret();
                if let Err(err) = app.emit("access_token", access_token) {
                    error!("Failed to emit access_token event: {err}");
                }
            }
            Err(err) => {
                error!("Failed to exchange OAuth code: {err}");
                if let Err(emit_err) = app.emit("access_token_error", err.to_string()) {
                    error!("Failed to emit access_token_error event: {emit_err}");
                }
            }
        }
    }

    // The callback has been served (successfully or not) - shut the
    // single-use server down so its socket is freed and a later
    // `authenticate()` call can rebind it.
    if let Ok(mut guard) = shutdown_tx.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }

    "authorized".to_string()
}

async fn run_server(handle: tauri::AppHandle) -> Result<(), axum::Error> {
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let shutdown_tx: ShutdownSender = Arc::new(Mutex::new(Some(shutdown_tx)));

    let app = Router::new()
        .route("/callback", get(authorize))
        .layer(Extension(handle.clone()))
        .layer(Extension(shutdown_tx));

    let socket_addr = handle.state::<AppState>().auth.socket_addr;

    let result = axum::Server::bind(&socket_addr)
        .serve(app.into_make_service())
        .with_graceful_shutdown(async {
            // If the sender is dropped without being fired (e.g. the process
            // is torn down early) this just resolves immediately.
            let _ = shutdown_rx.await;
        })
        .await;

    if let Err(err) = &result {
        error!("OAuth callback server error: {err}");
    }

    // Release the guard now that the socket has actually been freed, so a
    // subsequent `authenticate()` call can bind it again.
    handle
        .state::<AppState>()
        .auth
        .authenticating
        .store(false, Ordering::SeqCst);

    result.map_err(axum::Error::new)
}
