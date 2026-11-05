use discord_rich_presence::{
    activity::{Activity, Assets, Button, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde::Deserialize;
use std::sync::mpsc::{self, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DISCORD_CLIENT_ID: &str = "1391756250810810408";

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamState {
    pub url: String,
    pub channel: Option<String>,
    pub title: Option<String>,
    pub category: Option<String>,
    #[serde(default)]
    pub ad_active: bool,
}

pub struct DiscordController {
    sender: Sender<StreamState>,
}

impl DiscordController {
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel::<StreamState>();

        thread::spawn(move || {
            let mut client: Option<DiscordIpcClient> = None;
            let app_start_unix = current_unix_timestamp();
            let mut channel_start_unix = app_start_unix;
            let mut current_channel: Option<String> = None;
            let mut last_state: Option<StreamState> = None;
            let mut last_sent_at = Instant::now() - Duration::from_secs(60);

            loop {
                // Recevoir le dernier état disponible
                let mut next_state = match rx.recv_timeout(Duration::from_secs(10)) {
                    Ok(state) => Some(state),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };

                // Vider la file si plusieurs états sont arrivés rapidement
                while let Ok(newer) = rx.try_recv() {
                    next_state = Some(newer);
                }

                // Tenter une connexion à Discord IPC si non connecté
                if client.is_none() {
                    if let Ok(mut new_client) = DiscordIpcClient::new(DISCORD_CLIENT_ID) {
                        if new_client.connect().is_ok() {
                            println!("[Discord RPC] Connecté à Discord");
                            client = Some(new_client);
                            last_sent_at = Instant::now() - Duration::from_secs(60);
                        }
                    }
                }

                let state = match next_state.or_else(|| last_state.clone()) {
                    Some(s) => s,
                    None => continue,
                };

                // Réinitialiser le compteur de temps si l'utilisateur change de chaîne
                if state.channel != current_channel {
                    current_channel = state.channel.clone();
                    channel_start_unix = current_unix_timestamp();
                }

                // Éviter le spam de l'API Discord (rate-limit de 5 requêtes / 20s)
                if last_state.as_ref() == Some(&state)
                    && last_sent_at.elapsed() < Duration::from_secs(15)
                {
                    continue;
                }

                if let Some(ref mut ipc) = client {
                    let result = send_discord_activity(
                        ipc,
                        &state,
                        app_start_unix,
                        channel_start_unix,
                    );

                    if result.is_err() {
                        let _ = ipc.close();
                        client = None;
                    } else {
                        last_state = Some(state);
                        last_sent_at = Instant::now();
                    }
                }
            }
        });

        Self { sender: tx }
    }

    pub fn update(&self, state: StreamState) {
        let _ = self.sender.send(state);
    }
}

fn current_unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn send_discord_activity(
    ipc: &mut DiscordIpcClient,
    state: &StreamState,
    app_start_unix: i64,
    channel_start_unix: i64,
) -> Result<(), Box<dyn std::error::Error>> {
    if state.ad_active {
        if let Some(ref channel) = state.channel {
            let details = format!("Sur la chaîne de {}", channel);
            let activity = Activity::new()
                .details(&details)
                .state("🛡️ Publicité filtrée par TwitchApp (Rust)")
                .timestamps(Timestamps::new().start(channel_start_unix))
                .assets(
                    Assets::new()
                        .large_image("twitch")
                        .large_text("Anti-Pub TwitchApp actif"),
                );
            ipc.set_activity(activity)?;
            return Ok(());
        }
    }

    if let Some(ref channel) = state.channel {
        let details = match state.title.as_deref() {
            Some(title) if !title.trim().is_empty() => {
                truncate_str(&format!("📺 {} — {}", channel, title.trim()), 120)
            }
            _ => format!("Regarde {}", channel),
        };

        let status_line = match state.category.as_deref() {
            Some(cat) if !cat.trim().is_empty() => {
                truncate_str(&format!("Catégorie : {}", cat.trim()), 120)
            }
            _ => "En direct sur Twitch".to_string(),
        };

        let stream_url = format!("https://www.twitch.tv/{}", channel);
        let large_text = format!("TwitchApp Rust • {}", channel);

        let activity = Activity::new()
            .details(&details)
            .state(&status_line)
            .timestamps(Timestamps::new().start(channel_start_unix))
            .assets(
                Assets::new()
                    .large_image("twitch")
                    .large_text(&large_text),
            )
            .buttons(vec![Button::new("Regarder le stream", &stream_url)]);

        ipc.set_activity(activity)?;
    } else {
        let activity = Activity::new()
            .details("Navigue sur Twitch")
            .state("Menu principal")
            .timestamps(Timestamps::new().start(app_start_unix))
            .assets(
                Assets::new()
                    .large_image("twitch")
                    .large_text("TwitchApp (Rust)"),
            );
        ipc.set_activity(activity)?;
    }

    Ok(())
}

fn truncate_str(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        input.to_string()
    } else {
        let mut s: String = input.chars().take(max_chars.saturating_sub(1)).collect();
        s.push('…');
        s
    }
}

