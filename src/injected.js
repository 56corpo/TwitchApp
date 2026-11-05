(function () {
  if (window.__twitchAppRustInitialized) return;
  window.__twitchAppRustInitialized = true;

  // ==========================================================================
  // 1. PONT IPC VERS LE BACKEND RUST (WRY)
  // ==========================================================================
  function sendToRust(payload) {
    try {
      if (window.ipc && typeof window.ipc.postMessage === 'function') {
        window.ipc.postMessage(JSON.stringify(payload));
      }
    } catch (err) {
      console.warn('[TwitchApp Rust IPC]', err);
    }
  }

  // ==========================================================================
  // 2. HOOK ANTI-PUB HLS (.M3U8 VIDEO-SWAP) + GQL + DOMAINES PUBLICITAIRES
  //    Exécuté dans la fenêtre principale ET dans les WebWorkers Amazon IVS
  // ==========================================================================
  function workerAndMainAdblockHook() {
    const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
    const BACKUP_PLAYER_TYPES = ['embed', 'site', 'autoplay', 'picture-by-picture'];
    const AD_DOMAINS = [
      'doubleclick.net',
      'googlesyndication.com',
      'googleadservices.com',
      'google-analytics.com',
      'amazon-adsystem.com',
      'ads.twitch.tv',
      'edge.ads.twitch.tv',
      'scorecardresearch.com',
      'imrworldwide.com',
      'krxd.net',
      'branch.io',
      'moatads.com'
    ];
    const AD_SIGNATURES = [
      'stitched-ad',
      'twitch-stitched-ad',
      'Amazon-Ads',
      'X-TV-TWITCH-AD-URL',
      'X-TV-TWITCH-AD-CLICK-TRACKING-URL',
      'vod-stitched-ad'
    ];

    const streamMetaByChannel = new Map();
    const backupCache = new Map();
    const origFetch = self.fetch ? self.fetch.bind(self) : null;

    function isBlockedAdDomain(url) {
      if (!url || typeof url !== 'string') return false;
      return AD_DOMAINS.some((d) => url.includes(d));
    }

    function notifyAdStatus(active, channel, countIncrement) {
      try {
        if (typeof self.postMessage === 'function') {
          self.postMessage({
            __twitchAppAdEvent: true,
            active: Boolean(active),
            channel: channel || null,
            countIncrement: Boolean(countIncrement)
          });
        }
      } catch (_) {}
    }

    function hasAdMarkers(m3u8Text) {
      if (!m3u8Text || typeof m3u8Text !== 'string') return false;
      return AD_SIGNATURES.some((sig) => m3u8Text.includes(sig));
    }

    function stripAdSegmentsFromM3u8(m3u8Text, isShowingBackup) {
      const lines = m3u8Text.split(/\r?\n/);
      const out = [];
      let skipNextSegment = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (
          line.startsWith('#EXT-X-DATERANGE:') &&
          (line.includes('stitched-ad') || line.includes('Amazon') || line.includes('TWITCH-AD'))
        ) {
          continue;
        }

        if (
          line.startsWith('#EXT-X-TWITCH-PREFETCH:') &&
          (line.includes('stitched-ad') || line.includes('Amazon'))
        ) {
          continue;
        }

        if (
          !isShowingBackup &&
          line.startsWith('#EXTINF:') &&
          (line.includes('Amazon') || line.includes('stitched-ad') || line.includes('live-ad'))
        ) {
          const nonAdSegments = lines.filter(
            (l) => l.startsWith('#EXTINF:') && !l.includes('Amazon') && !l.includes('stitched-ad')
          );
          if (nonAdSegments.length >= 2) {
            skipNextSegment = true;
            continue;
          }
        }

        if (skipNextSegment) {
          if (!line.startsWith('#')) {
            skipNextSegment = false;
            continue;
          }
        }

        out.push(line);
      }

      return out.join('\n');
    }

    async function fetchBackupAccessToken(channelName, playerType) {
      const query = {
        operationName: 'PlaybackAccessToken',
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712'
          }
        },
        variables: {
          isLive: true,
          login: channelName,
          isVod: false,
          vodID: '',
          playerType: playerType
        }
      };

      const res = await origFetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
          'Client-ID': CLIENT_ID,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(query)
      });

      if (!res.ok) return null;
      const json = await res.json();
      return json?.data?.streamPlaybackAccessToken || null;
    }

    async function getCleanBackupM3u8(channelName) {
      if (!channelName) return null;

      const cached = backupCache.get(channelName);
      if (cached && Date.now() - cached.timestamp < 25000) {
        try {
          const mediaRes = await origFetch(cached.url);
          if (mediaRes.ok) {
            const text = await mediaRes.text();
            if (!hasAdMarkers(text)) {
              return text;
            }
          }
        } catch (_) {}
        backupCache.delete(channelName);
      }

      for (const playerType of BACKUP_PLAYER_TYPES) {
        try {
          const tokenData = await fetchBackupAccessToken(channelName, playerType);
          if (!tokenData || !tokenData.value || !tokenData.signature) continue;

          const params = new URLSearchParams({
            platform: 'web',
            player_backend: 'mediaplayer',
            player_type: playerType,
            allow_source: 'true',
            allow_audio_only: 'true',
            allow_spectre: 'false',
            fast_bread: 'true',
            sig: tokenData.signature,
            token: tokenData.value,
            p: String(Math.floor(Math.random() * 999999))
          });

          const usherUrl =
            'https://usher.ttvnw.net/api/channel/hls/' +
            encodeURIComponent(channelName) +
            '.m3u8?' +
            params.toString();
          const masterRes = await origFetch(usherUrl);
          if (!masterRes.ok) continue;

          const masterText = await masterRes.text();
          const lines = masterText
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          const mediaUrls = lines.filter((l) => l.startsWith('https://'));

          if (mediaUrls.length === 0) continue;

          const chosenUrl = mediaUrls[0];
          const mediaRes = await origFetch(chosenUrl);
          if (!mediaRes.ok) continue;

          const mediaText = await mediaRes.text();
          if (!hasAdMarkers(mediaText)) {
            backupCache.set(channelName, { url: chosenUrl, timestamp: Date.now(), playerType });
            return mediaText;
          }
        } catch (_) {}
      }

      return null;
    }

    if (origFetch) {
      self.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : input && input.url ? input.url : '';

        // 1. Bloquer les domaines de régies publicitaires et trackers
        if (isBlockedAdDomain(url)) {
          return new Response('', { status: 204 });
        }

        // 2. Neutraliser les requêtes GraphQL de télémétrie pub sans faire planter le lecteur
        if (url.includes('gql.twitch.tv/gql') && init && typeof init.body === 'string') {
          if (
            init.body.includes('ClientSideAdEventHandling_RecordAdEvent') ||
            init.body.includes('PlaybackAccessToken_Ads') ||
            init.body.includes('VideoAdBanner') ||
            init.body.includes('AdRequestHandling') ||
            init.body.includes('CommercialBreak')
          ) {
            const isBatch = init.body.trim().startsWith('[');
            const fakePayload = isBatch ? [{ data: {} }] : { data: {} };
            return new Response(JSON.stringify(fakePayload), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }

        // 3. Associer la chaîne aux URLs video-weaver depuis la Master Playlist
        if (url.includes('usher.ttvnw.net/api/channel/hls/')) {
          const match = url.match(/\/hls\/([^.?]+)\.m3u8/i);
          const channelName = match ? decodeURIComponent(match[1]).toLowerCase() : null;
          const response = await origFetch(input, init);
          if (channelName && response.ok) {
            try {
              const cloneText = await response.clone().text();
              const urls = cloneText
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l.startsWith('https://'));
              for (const mediaUrl of urls) {
                streamMetaByChannel.set(mediaUrl.split('?')[0], channelName);
              }
            } catch (_) {}
          }
          return response;
        }

        // 4. Intercepter les Media Playlists HLS (video-weaver.*.hls.ttvnw.net)
        if (url.includes('video-weaver.') && url.includes('.hls.ttvnw.net')) {
          const response = await origFetch(input, init);
          if (!response.ok) return response;

          try {
            const text = await response.clone().text();
            if (hasAdMarkers(text)) {
              const baseMediaUrl = url.split('?')[0];
              const channelName = streamMetaByChannel.get(baseMediaUrl) || null;

              const cleanBackup = await getCleanBackupM3u8(channelName);
              notifyAdStatus(true, channelName, true);

              if (cleanBackup) {
                const cleaned = stripAdSegmentsFromM3u8(cleanBackup, true);
                return new Response(cleaned, {
                  status: 200,
                  statusText: 'OK',
                  headers: response.headers
                });
              }

              const stripped = stripAdSegmentsFromM3u8(text, false);
              return new Response(stripped, {
                status: 200,
                statusText: 'OK',
                headers: response.headers
              });
            } else {
              notifyAdStatus(false, null, false);
            }
          } catch (_) {}

          return response;
        }

        return origFetch(input, init);
      };
    }

    // Bloquer également XMLHttpRequest vers les régies publicitaires
    if (self.XMLHttpRequest) {
      const origOpen = self.XMLHttpRequest.prototype.open;
      const origSend = self.XMLHttpRequest.prototype.send;

      self.XMLHttpRequest.prototype.open = function (method, url) {
        this.__twitchAppBlocked = isBlockedAdDomain(String(url || ''));
        return origOpen.apply(this, arguments);
      };

      self.XMLHttpRequest.prototype.send = function () {
        if (this.__twitchAppBlocked) {
          return;
        }
        return origSend.apply(this, arguments);
      };
    }
  }

  // Exécuter immédiatement dans le contexte Main-World
  try {
    workerAndMainAdblockHook();
  } catch (err) {
    console.warn('[TwitchApp Rust Adblock]', err);
  }

  // Wrapper tous les WebWorkers (Blob & URL) créés par le lecteur vidéo de Twitch
  const hookSource = workerAndMainAdblockHook.toString();
  const OrigWorker = window.Worker;
  window.Worker = function (scriptURL, options) {
    let finalUrl = scriptURL;
    try {
      if (
        typeof scriptURL === 'string' &&
        (scriptURL.startsWith('blob:') || scriptURL.startsWith('http'))
      ) {
        const wrapperCode =
          '(' + hookSource + ')();\nimportScripts(' + JSON.stringify(scriptURL) + ');';
        const blob = new Blob([wrapperCode], { type: 'application/javascript' });
        finalUrl = URL.createObjectURL(blob);
      }
    } catch (_) {}

    const workerInstance = new OrigWorker(finalUrl, options);
    if (workerInstance && typeof workerInstance.addEventListener === 'function') {
      workerInstance.addEventListener('message', (ev) => {
        if (ev.data && ev.data.__twitchAppAdEvent) {
          window.postMessage(ev.data, '*');
        }
      });
    }
    return workerInstance;
  };
  window.Worker.prototype = OrigWorker.prototype;

  // ==========================================================================
  // 3. STYLES CSS (FILTRAGE COSMÉTIQUE PUB + INTERFACE EMOTES 7TV/BTTV/FFZ)
  // ==========================================================================
  function injectStyles() {
    const root = document.head || document.documentElement;
    if (!root) {
      requestAnimationFrame(injectStyles);
      return;
    }
    if (document.getElementById('twitchapp-rust-styles')) return;

    const style = document.createElement('style');
    style.id = 'twitchapp-rust-styles';
    style.textContent = `
      /* Filtrage cosmétique des publicités Twitch */
      .stream-display-ad__container,
      .stream-display-ad__wrapper,
      [data-a-target="video-ad-banner"],
      [data-a-target="ax-overlay"],
      [data-a-target="sad-overlay"],
      .ad-banner,
      .tw-ad-container,
      div[data-test-selector="ad-banner-default-text"],
      div[aria-label="Publicité"],
      div[aria-label="Advertisement"] {
        display: none !important;
        height: 0 !important;
        width: 0 !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }

      /* Emotes 7TV / BTTV / FFZ dans le chat */
      .twitchapp-emote-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
        vertical-align: middle;
        margin: -2px 2px;
        line-height: 1;
      }
      .twitchapp-emote {
        height: 28px;
        width: auto;
        max-width: 112px;
        object-fit: contain;
        vertical-align: middle;
        cursor: pointer;
      }
      .twitchapp-emote-zw {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        pointer-events: none;
        height: 28px;
        width: auto;
      }

      /* Infobulle au survol d'une emote */
      #twitchapp-emote-tooltip {
        position: fixed;
        z-index: 999999;
        background: rgba(14, 14, 16, 0.96);
        border: 1px solid rgba(145, 71, 255, 0.45);
        border-radius: 8px;
        padding: 8px 12px;
        display: none;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        pointer-events: none;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.65);
        color: #efeff1;
        font-family: Inter, Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif;
        text-align: center;
        backdrop-filter: blur(6px);
      }
      #twitchapp-emote-tooltip img {
        max-height: 64px;
        max-width: 140px;
        object-fit: contain;
      }
      #twitchapp-emote-tooltip .ta-tt-name {
        font-weight: 700;
        font-size: 13px;
        color: #fff;
      }
      #twitchapp-emote-tooltip .ta-tt-badge {
        font-size: 11px;
        padding: 1px 6px;
        border-radius: 4px;
        font-weight: 600;
      }
      .ta-badge-7TV { background: #29b6f6; color: #000; }
      .ta-badge-BTTV { background: #d50000; color: #fff; }
      .ta-badge-FFZ { background: #3b82f6; color: #fff; }

      /* Badge de statut TwitchApp Rust dans la barre supérieure */
      #twitchapp-status-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: rgba(24, 24, 27, 0.9);
        border: 1px solid rgba(145, 71, 255, 0.4);
        color: #efeff1;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        margin: 0 8px;
        user-select: none;
        cursor: pointer;
        transition: border-color 0.2s, background 0.2s;
      }
      #twitchapp-status-pill:hover {
        border-color: #9147ff;
        background: rgba(38, 38, 44, 0.95);
      }
      #twitchapp-status-pill .ta-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #00e676;
        display: inline-block;
      }
      #twitchapp-status-pill.ad-active .ta-dot {
        background: #ffab00;
        box-shadow: 0 0 8px #ffab00;
      }

      /* Bouton et panneau Sélecteur d'Emotes 7TV / BTTV / FFZ */
      #twitchapp-emote-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: rgba(145, 71, 255, 0.18);
        color: #bf94ff;
        border: 1px solid rgba(145, 71, 255, 0.4);
        border-radius: 4px;
        padding: 3px 7px;
        font-size: 11px;
        font-weight: 800;
        cursor: pointer;
        margin-right: 4px;
        height: 26px;
        transition: all 0.15s ease;
      }
      #twitchapp-emote-btn:hover {
        background: #9147ff;
        color: #fff;
      }
      #twitchapp-emote-picker {
        position: fixed;
        bottom: 70px;
        right: 20px;
        width: 320px;
        height: 390px;
        background: #18181b;
        border: 1px solid #303032;
        border-radius: 8px;
        z-index: 999998;
        display: none;
        flex-direction: column;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.7);
        font-family: Inter, Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif;
        color: #efeff1;
        overflow: hidden;
      }
      #twitchapp-emote-picker.open {
        display: flex;
      }
      .ta-picker-header {
        padding: 8px;
        background: #1f1f23;
        border-bottom: 1px solid #303032;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .ta-picker-search {
        width: 100%;
        background: #0e0e10;
        border: 1px solid #3a3a3d;
        color: #fff;
        padding: 6px 8px;
        border-radius: 4px;
        font-size: 12px;
        outline: none;
        box-sizing: border-box;
      }
      .ta-picker-search:focus {
        border-color: #9147ff;
      }
      .ta-picker-tabs {
        display: flex;
        gap: 4px;
      }
      .ta-picker-tab {
        flex: 1;
        background: #26262c;
        border: none;
        color: #adadb8;
        padding: 4px 0;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
      }
      .ta-picker-tab.active {
        background: #9147ff;
        color: #fff;
      }
      .ta-picker-grid {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
        gap: 6px;
        align-content: start;
      }
      .ta-picker-item {
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.03);
        cursor: pointer;
        padding: 2px;
        transition: background 0.12s, transform 0.12s;
      }
      .ta-picker-item:hover {
        background: rgba(145, 71, 255, 0.28);
        transform: scale(1.08);
      }
      .ta-picker-item img {
        max-height: 32px;
        max-width: 100%;
        object-fit: contain;
      }
    `;
    root.appendChild(style);
  }

  injectStyles();

  // ==========================================================================
  // 4. GESTION DES EMOTES (7TV / BTTV / FFZ) & ÉTAT DU STREAM
  // ==========================================================================
  const NON_CHANNEL_SEGMENTS = new Set([
    '',
    'directory',
    'videos',
    'search',
    'clip',
    'drops',
    'inventory',
    'wallet',
    'subscriptions',
    'settings',
    'friends',
    'prime',
    'turbo',
    'downloads',
    'jobs',
    'p',
    'u',
    'popout',
    'embed',
    'moderator',
    'login',
    'signup',
    'logout'
  ]);

  let currentChannel = null;
  let lastRequestedChannel = '__init__';
  let emoteMap = new Map();
  let emoteList = [];
  let emoteCounts = { total: 0, '7TV': 0, BTTV: 0, FFZ: 0 };
  let adsBlockedCount = 0;
  let isAdCurrentlyActive = false;
  let activePickerProvider = 'ALL';
  let pickerSearchQuery = '';
  let wasMutedByAdblock = false;
  let savedVolume = 1;

  // Appelé directement par le backend Rust via webview.evaluate_script(...)
  window.__twitchAppReceiveEmotes = function (data) {
    if (!data || !Array.isArray(data.emotes)) return;

    const nextMap = new Map();
    for (const em of data.emotes) {
      nextMap.set(em.name, em);
    }

    emoteMap = nextMap;
    emoteList = data.emotes;
    emoteCounts = data.counts || { total: data.emotes.length, '7TV': 0, BTTV: 0, FFZ: 0 };
    updateStatusPill();
    renderPickerGrid();
    processExistingChatMessages();
  };

  window.addEventListener('message', (event) => {
    if (event.data && event.data.__twitchAppAdEvent) {
      const { active, countIncrement } = event.data;
      if (countIncrement && !isAdCurrentlyActive) {
        adsBlockedCount++;
      }
      if (isAdCurrentlyActive !== Boolean(active)) {
        isAdCurrentlyActive = Boolean(active);
        updateStatusPill();
        sendStreamStateToRust();
      }
    }
  });

  function detectCurrentChannel() {
    try {
      const { pathname } = window.location;
      const segments = pathname.split('/').filter(Boolean);
      if (segments.length === 0) return null;

      if ((segments[0] === 'popout' || segments[0] === 'moderator') && segments[1]) {
        const candidate = segments[1].toLowerCase();
        return NON_CHANNEL_SEGMENTS.has(candidate) ? null : candidate;
      }

      const first = segments[0].toLowerCase();
      if (NON_CHANNEL_SEGMENTS.has(first)) return null;
      return first;
    } catch (_) {
      return null;
    }
  }

  function sendStreamStateToRust() {
    const channel = detectCurrentChannel();
    const titleEl = document.querySelector('[data-a-target="stream-title"]');
    const categoryEl = document.querySelector('[data-a-target="stream-game-link"]');

    sendToRust({
      kind: 'state_update',
      state: {
        url: window.location.href,
        channel: channel,
        title: titleEl ? titleEl.textContent.trim() : null,
        category: categoryEl ? categoryEl.textContent.trim() : null,
        adActive: isAdCurrentlyActive
      }
    });
  }

  function requestEmotesFromRust(channel) {
    if (channel === lastRequestedChannel) return;
    lastRequestedChannel = channel;
    sendToRust({
      kind: 'fetch_emotes',
      channel: channel || ''
    });
  }

  // Surveillance DOM de secours pour les overlays publicitaires
  function checkDomAdOverlay() {
    const adOverlay = document.querySelector(
      '[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], .video-player__ad-overlay'
    );
    const video = document.querySelector('video');
    if (!video) return;

    if (adOverlay) {
      if (!wasMutedByAdblock) {
        wasMutedByAdblock = true;
        savedVolume = video.volume;
        video.muted = true;
        window.postMessage({ __twitchAppAdEvent: true, active: true, countIncrement: true }, '*');
      }
      adOverlay.style.opacity = '0.2';
    } else if (wasMutedByAdblock) {
      wasMutedByAdblock = false;
      video.muted = false;
      video.volume = savedVolume;
      window.postMessage({ __twitchAppAdEvent: true, active: false, countIncrement: false }, '*');
    }
  }

  // ==========================================================================
  // 5. RENDU DES EMOTES DANS LE CHAT
  // ==========================================================================
  let tooltipEl = null;

  function ensureTooltip() {
    if (tooltipEl && document.body && document.body.contains(tooltipEl)) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'twitchapp-emote-tooltip';
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function showEmoteTooltip(emote, anchorEl) {
    const tt = ensureTooltip();
    tt.replaceChildren();

    const img = document.createElement('img');
    img.src = emote.url4x || emote.url2x || emote.url1x;
    img.alt = emote.name;

    const nameSpan = document.createElement('div');
    nameSpan.className = 'ta-tt-name';
    nameSpan.textContent = emote.name;

    const badgeSpan = document.createElement('div');
    badgeSpan.className = `ta-tt-badge ta-badge-${emote.provider}`;
    badgeSpan.textContent = `${emote.provider} • ${emote.scope === 'Global' ? 'Global' : 'Chaîne'}`;

    tt.appendChild(img);
    tt.appendChild(nameSpan);
    tt.appendChild(badgeSpan);
    tt.style.display = 'flex';

    const rect = anchorEl.getBoundingClientRect();
    const top = Math.max(8, rect.top - tt.offsetHeight - 8);
    const left = Math.min(
      window.innerWidth - tt.offsetWidth - 8,
      Math.max(8, rect.left + rect.width / 2 - tt.offsetWidth / 2)
    );

    tt.style.top = `${top}px`;
    tt.style.left = `${left}px`;
  }

  function hideEmoteTooltip() {
    if (tooltipEl) {
      tooltipEl.style.display = 'none';
    }
  }

  function createEmoteNode(emote, isZeroWidthOverlay = false) {
    const img = document.createElement('img');
    img.className = isZeroWidthOverlay ? 'twitchapp-emote-zw' : 'twitchapp-emote';
    img.src = emote.url1x;
    if (emote.url2x) {
      img.srcset = `${emote.url1x} 1x, ${emote.url2x} 2x`;
    }
    img.alt = emote.name;
    img.draggable = false;

    if (isZeroWidthOverlay) {
      return img;
    }

    const wrap = document.createElement('span');
    wrap.className = 'twitchapp-emote-wrap';
    wrap.appendChild(img);

    wrap.addEventListener('mouseenter', () => showEmoteTooltip(emote, wrap));
    wrap.addEventListener('mouseleave', hideEmoteTooltip);
    wrap.addEventListener('click', () => insertEmoteIntoChat(emote.name));

    return wrap;
  }

  function transformTextFragment(fragmentEl) {
    if (!fragmentEl || fragmentEl.dataset.taEmoteDone === '1' || emoteMap.size === 0) return;

    const rawText = fragmentEl.textContent;
    if (!rawText || !rawText.trim()) return;

    const tokens = rawText.split(/(\s+)/);
    let hasMatch = false;

    for (const token of tokens) {
      if (emoteMap.has(token)) {
        hasMatch = true;
        break;
      }
    }

    fragmentEl.dataset.taEmoteDone = '1';
    if (!hasMatch) return;

    const docFrag = document.createDocumentFragment();
    let lastEmoteWrapper = null;

    for (const token of tokens) {
      const emote = emoteMap.get(token);
      if (emote) {
        if (emote.zeroWidth && lastEmoteWrapper) {
          const zwImg = createEmoteNode(emote, true);
          lastEmoteWrapper.appendChild(zwImg);
        } else {
          const wrapper = createEmoteNode(emote, false);
          lastEmoteWrapper = wrapper;
          docFrag.appendChild(wrapper);
        }
      } else {
        if (token.trim().length > 0) {
          lastEmoteWrapper = null;
        }
        docFrag.appendChild(document.createTextNode(token));
      }
    }

    fragmentEl.replaceChildren(docFrag);
  }

  function processChatNode(rootNode) {
    if (!rootNode || rootNode.nodeType !== Node.ELEMENT_NODE) return;

    if (rootNode.matches?.('.text-fragment, [data-a-target="chat-message-text"]')) {
      transformTextFragment(rootNode);
      return;
    }

    const fragments = rootNode.querySelectorAll?.(
      '.text-fragment:not([data-ta-emote-done="1"]), [data-a-target="chat-message-text"]:not([data-ta-emote-done="1"])'
    );
    if (fragments && fragments.length > 0) {
      for (const frag of fragments) {
        transformTextFragment(frag);
      }
    }
  }

  function processExistingChatMessages() {
    const fragments = document.querySelectorAll(
      '.text-fragment, [data-a-target="chat-message-text"]'
    );
    for (const frag of fragments) {
      delete frag.dataset.taEmoteDone;
      transformTextFragment(frag);
    }
  }

  // ==========================================================================
  // 6. SÉLECTEUR D'EMOTES INTÉGRÉ & AUTOCOMPLÉTION TAB
  // ==========================================================================
  function getChatInputElement() {
    return (
      document.querySelector('[data-a-target="chat-input"]') ||
      document.querySelector('div[role="textbox"][contenteditable="true"]') ||
      document.querySelector('textarea[data-a-target="chat-input"]')
    );
  }

  function insertEmoteIntoChat(emoteName) {
    const input = getChatInputElement();
    if (!input) return;

    input.focus();
    const textToInsert = `${emoteName} `;

    if (input.isContentEditable) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        document.execCommand('insertText', false, textToInsert);
      } else {
        input.textContent += textToInsert;
      }
      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textToInsert })
      );
      return;
    }

    if (typeof input.value === 'string') {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      const nextValue = input.value.slice(0, start) + textToInsert + input.value.slice(end);
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(input, nextValue);
      } else {
        input.value = nextValue;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function ensureEmotePickerUI() {
    if (!document.body) return;

    let picker = document.getElementById('twitchapp-emote-picker');
    if (!picker) {
      picker = document.createElement('div');
      picker.id = 'twitchapp-emote-picker';

      const header = document.createElement('div');
      header.className = 'ta-picker-header';

      const searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'ta-picker-search';
      searchInput.placeholder = 'Rechercher une emote 7TV, BTTV, FFZ...';
      searchInput.addEventListener('input', (e) => {
        pickerSearchQuery = e.target.value.trim().toLowerCase();
        renderPickerGrid();
      });

      const tabs = document.createElement('div');
      tabs.className = 'ta-picker-tabs';

      for (const tabKey of ['ALL', '7TV', 'BTTV', 'FFZ']) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `ta-picker-tab ${activePickerProvider === tabKey ? 'active' : ''}`;
        btn.textContent = tabKey === 'ALL' ? 'Toutes' : tabKey;
        btn.addEventListener('click', () => {
          activePickerProvider = tabKey;
          for (const child of tabs.children) {
            child.classList.remove('active');
          }
          btn.classList.add('active');
          renderPickerGrid();
        });
        tabs.appendChild(btn);
      }

      const grid = document.createElement('div');
      grid.id = 'twitchapp-picker-grid';
      grid.className = 'ta-picker-grid';

      header.appendChild(searchInput);
      header.appendChild(tabs);
      picker.appendChild(header);
      picker.appendChild(grid);
      document.body.appendChild(picker);

      document.addEventListener('click', (e) => {
        const btn = document.getElementById('twitchapp-emote-btn');
        if (picker.classList.contains('open') && !picker.contains(e.target) && e.target !== btn) {
          picker.classList.remove('open');
        }
      });
    }

    const buttonsContainer =
      document.querySelector('.chat-input__buttons-container div:last-child') ||
      document.querySelector('[data-a-target="chat-send-button"]')?.parentElement;

    if (buttonsContainer && !document.getElementById('twitchapp-emote-btn')) {
      const btn = document.createElement('button');
      btn.id = 'twitchapp-emote-btn';
      btn.type = 'button';
      btn.title = 'Ouvrir les emotes 7TV / BTTV / FFZ';
      btn.textContent = '7TV';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        picker.classList.toggle('open');
        if (picker.classList.contains('open')) {
          renderPickerGrid();
        }
      });
      buttonsContainer.prepend(btn);
    }
  }

  function renderPickerGrid() {
    const grid = document.getElementById('twitchapp-picker-grid');
    if (!grid) return;

    grid.replaceChildren();

    const filtered = emoteList.filter((em) => {
      if (activePickerProvider !== 'ALL' && em.provider !== activePickerProvider) return false;
      if (pickerSearchQuery && !em.name.toLowerCase().includes(pickerSearchQuery)) return false;
      return true;
    });

    const slice = filtered.slice(0, 250);
    const frag = document.createDocumentFragment();

    for (const em of slice) {
      const cell = document.createElement('div');
      cell.className = 'ta-picker-item';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = em.url1x;
      img.alt = em.name;

      cell.appendChild(img);
      cell.addEventListener('mouseenter', () => showEmoteTooltip(em, cell));
      cell.addEventListener('mouseleave', hideEmoteTooltip);
      cell.addEventListener('click', () => {
        insertEmoteIntoChat(em.name);
      });

      frag.appendChild(cell);
    }

    grid.appendChild(frag);
  }

  let tabMatches = [];
  let tabIndex = 0;
  let lastTabPrefix = null;

  function setupTabAutocomplete() {
    document.addEventListener(
      'keydown',
      (e) => {
        // Raccourcis globaux F5 / F12 / Ctrl+Shift+I remontés à Rust
        if (e.key === 'F5') {
          e.preventDefault();
          window.location.reload();
          return;
        }
        if (
          e.key === 'F12' ||
          ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'i')
        ) {
          sendToRust({ kind: 'open_devtools' });
          return;
        }

        if (e.key !== 'Tab') {
          lastTabPrefix = null;
          return;
        }

        const input = getChatInputElement();
        if (!input || document.activeElement !== input || emoteList.length === 0) return;

        const rawText = input.isContentEditable ? input.textContent || '' : input.value || '';
        const words = rawText.split(/\s+/);
        const currentWord = words[words.length - 1]?.replace(/^:/, '') || '';

        if (currentWord.length < 2) return;

        if (lastTabPrefix === null) {
          lastTabPrefix = currentWord.toLowerCase();
          tabMatches = emoteList
            .filter((em) => em.name.toLowerCase().startsWith(lastTabPrefix))
            .map((em) => em.name);
          tabIndex = 0;
        } else {
          tabIndex = (tabIndex + 1) % Math.max(1, tabMatches.length);
        }

        if (tabMatches.length === 0) return;

        e.preventDefault();
        e.stopPropagation();

        const replacement = tabMatches[tabIndex];
        if (input.isContentEditable) {
          for (let i = 0; i < currentWord.length; i++) {
            document.execCommand('delete', false, null);
          }
          document.execCommand('insertText', false, `${replacement} `);
        }
      },
      true
    );
  }

  function updateStatusPill() {
    let pill = document.getElementById('twitchapp-status-pill');
    const navRight =
      document.querySelector('[data-a-target="top-nav-container"] .Layout-sc-1xcs6mc-0:last-child') ||
      document.querySelector('nav .InjectLayout-sc-1i43xsx-0');

    if (!pill && navRight) {
      pill = document.createElement('div');
      pill.id = 'twitchapp-status-pill';
      pill.title = 'TwitchApp (Rust) • Cliquez pour ouvrir le sélecteur 7TV / BTTV / FFZ';
      pill.addEventListener('click', () => {
        const picker = document.getElementById('twitchapp-emote-picker');
        if (picker) {
          picker.classList.toggle('open');
          renderPickerGrid();
        }
      });
      navRight.prepend(pill);
    }

    if (!pill) return;

    pill.classList.toggle('ad-active', isAdCurrentlyActive);
    pill.replaceChildren();

    const dot = document.createElement('span');
    dot.className = 'ta-dot';

    const label = document.createElement('span');
    const adText = isAdCurrentlyActive
      ? '🦀 Filtrage pub...'
      : `🦀 Anti-Pub (${adsBlockedCount})`;
    const emoteText = `7TV/BTTV/FFZ : ${emoteCounts.total || 0}`;
    label.textContent = `${adText} • ${emoteText}`;

    pill.appendChild(dot);
    pill.appendChild(label);
  }

  function bootDomFeatures() {
    injectStyles();
    setupTabAutocomplete();

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) {
          processChatNode(added);
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    const tick = () => {
      const detected = detectCurrentChannel();
      if (detected !== currentChannel || lastRequestedChannel === '__init__') {
        currentChannel = detected;
        requestEmotesFromRust(currentChannel);
      }
      checkDomAdOverlay();
      ensureEmotePickerUI();
      updateStatusPill();
      sendStreamStateToRust();
    };

    tick();
    setInterval(tick, 2000);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', bootDomFeatures, { once: true });
  } else {
    bootDomFeatures();
  }
})();

