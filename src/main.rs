#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adblock;
mod discord;
mod emotes;

use adblock::{is_allowed_twitch_domain, CLEAN_USER_AGENT, INITIALIZATION_SCRIPT};
use discord::{DiscordController, StreamState};
use serde::Deserialize;
use std::thread;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Icon, WindowBuilder},
};
use wry::{http::Request, NewWindowResponse, WebViewBuilder};

const EMBEDDED_ICON_PNG: &[u8] = include_bytes!("../assets/icon.png");

enum UserEvent {
    EmotesLoaded(String),
    OpenDevTools,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum IpcMessage {
    FetchEmotes { channel: String },
    StateUpdate { state: StreamState },
    OpenDevtools,
}

fn load_window_icon() -> Option<Icon> {
    let img = image::load_from_memory(EMBEDDED_ICON_PNG).ok()?.into_rgba8();
    let (width, height) = img.dimensions();
    Icon::from_rgba(img.into_raw(), width, height).ok()
}

fn main() -> wry::Result<()> {
    // 1. Démarrer le contrôleur Discord Rich Presence dans un thread dédié
    let discord = DiscordController::spawn();

    // 2. Construire la boucle d'événements Tao et la fenêtre native
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title("TwitchApp")
        .with_inner_size(LogicalSize::new(1360.0, 860.0))
        .with_min_inner_size(LogicalSize::new(900.0, 600.0))
        .with_window_icon(load_window_icon())
        .build(&event_loop)
        .expect("Impossible de créer la fenêtre principale");

    // 3. Précharger les emotes globales en arrière-plan dès le lancement
    thread::spawn(|| {
        let _ = emotes::fetch_global_emotes();
    });

    // 4. Construire le WebView (WebView2 sous Windows, WebKit sous macOS/Linux)
    let ipc_proxy = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_url("https://www.twitch.tv")
        .with_user_agent(CLEAN_USER_AGENT)
        .with_devtools(true)
        .with_initialization_script(INITIALIZATION_SCRIPT)
        .with_navigation_handler(|url: String| {
            if is_allowed_twitch_domain(&url) {
                true
            } else {
                let _ = open::that(&url);
                false
            }
        })
        .with_new_window_req_handler(|url: String| {
            if is_allowed_twitch_domain(&url) {
                NewWindowResponse::Allow
            } else {
                let _ = open::that(&url);
                NewWindowResponse::Deny
            }
        })
        .with_ipc_handler(move |req: Request<String>| {
            let body = req.body();
            if let Ok(message) = serde_json::from_str::<IpcMessage>(body) {
                match message {
                    IpcMessage::FetchEmotes { channel } => {
                        let thread_proxy = ipc_proxy.clone();
                        thread::spawn(move || {
                            let payload = emotes::get_emotes_for_channel(&channel);
                            if let Ok(json_str) = serde_json::to_string(&payload) {
                                let _ = thread_proxy.send_event(UserEvent::EmotesLoaded(json_str));
                            }
                        });
                    }
                    IpcMessage::StateUpdate { state } => {
                        discord.update(state);
                    }
                    IpcMessage::OpenDevtools => {
                        let _ = ipc_proxy.send_event(UserEvent::OpenDevTools);
                    }
                }
            }
        })
        .build(&window)?;

    // 5. Boucle principale d'événements
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::EmotesLoaded(json_payload)) => {
                let js = format!(
                    "if (window.__twitchAppReceiveEmotes) {{ window.__twitchAppReceiveEmotes({}); }}",
                    json_payload
                );
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(UserEvent::OpenDevTools) => {
                webview.open_devtools();
            }
            _ => {}
        }
    });
}

