const icons = {
    events: `
        <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M8 6h11M8 12h11M8 18h11" />
            <circle cx="4" cy="6" r="1" />
            <circle cx="4" cy="12" r="1" />
            <circle cx="4" cy="18" r="1" />
        </svg>`,
    hangup: `
        <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M5.1 15.2c4.4-3.5 9.4-3.5 13.8 0" />
            <path d="m7.8 13.5-1.2 4-3-1.1.9-3.7M16.2 13.5l1.2 4 3-1.1-.9-3.7" />
        </svg>`,
    camera: `
        <svg aria-hidden="true" viewBox="0 0 24 24">
            <rect x="3" y="6" width="13" height="12" rx="2" />
            <path d="m16 10 5-3v10l-5-3" />
        </svg>`,
    microphone: `
        <svg aria-hidden="true" viewBox="0 0 24 24">
            <rect x="9" y="3" width="6" height="12" rx="3" />
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" />
        </svg>`,
    person: `
        <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="12" cy="8" r="3.25" />
            <path d="M5.5 19c.8-3.3 3-5 6.5-5s5.7 1.7 6.5 5" />
        </svg>`,
    retry: `
        <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M19 8a8 8 0 1 0 .4 7" />
            <path d="M19 3v5h-5" />
        </svg>`
};

const meterBars = Array.from(
    { length: 5 },
    () => '<i data-meter-bar></i>'
).join("");

function element(root, role) {
    return root.querySelector(`[data-call-role="${role}"]`);
}

export function mountVideoCall(root, {
    actionLabel,
    participantLabel,
    showEvents = false,
    showHangup = true,
    showMediaControls = true
}) {
    root.className = "panel call-panel";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Call");
    root.innerHTML = `
        <div class="video-stage">
            <video
                class="remote-video"
                data-call-role="remote-video"
                autoplay
                playsinline
            ></video>

            <div class="participant-badge" aria-label="Person on this call">
                <span class="participant-icon">${icons.person}</span>
                <span data-call-role="participant">${participantLabel}</span>
                <span
                    class="audio-meter"
                    data-call-role="remote-audio-meter"
                    aria-hidden="true"
                >${meterBars}</span>
            </div>

            ${showEvents ? `
                <button
                    class="stage-button events-button"
                    data-call-role="events-toggle"
                    type="button"
                    aria-expanded="false"
                    aria-controls="call-events-panel"
                >
                    ${icons.events}
                    <span>Events</span>
                    <span class="event-count" data-call-role="event-count">0</span>
                </button>

                <aside
                    class="events-drawer"
                    data-call-role="events-drawer"
                    id="call-events-panel"
                    aria-label="Call events"
                    hidden
                >
                    <div class="drawer-heading">
                        <div>
                            <p class="eyebrow">Activity</p>
                            <h2>Call events</h2>
                        </div>
                        <button
                            class="icon-button drawer-close"
                            data-call-role="events-close"
                            type="button"
                            aria-label="Close events"
                        >&#215;</button>
                    </div>
                    <ol
                        class="events-list"
                        data-call-role="events"
                        aria-live="polite"
                    ></ol>
                    <p class="events-empty">Events will appear when the call starts.</p>
                </aside>
            ` : ""}

            <div class="local-preview">
                <video data-call-role="local-video" autoplay muted playsinline></video>
                <span>You</span>
                <span
                    class="audio-meter local-audio-meter"
                    data-call-role="local-audio-meter"
                    aria-hidden="true"
                >${meterBars}</span>
            </div>

            <div class="stage-call-controls" aria-label="In-call controls">
                ${showMediaControls ? `
                    <button
                        class="stage-control media-control"
                        data-call-role="mute"
                        type="button"
                        aria-label="Mute microphone"
                        aria-pressed="false"
                        title="Mute microphone"
                        disabled
                    >
                        ${icons.microphone}
                        <span class="visually-hidden">Mute microphone</span>
                    </button>
                    <button
                        class="stage-control media-control"
                        data-call-role="camera"
                        type="button"
                        aria-label="Hide camera"
                        aria-pressed="false"
                        title="Hide camera"
                        disabled
                    >
                        ${icons.camera}
                        <span class="visually-hidden">Hide camera</span>
                    </button>
                ` : ""}
                <button
                    class="stage-control retry-control"
                    data-call-role="retry"
                    type="button"
                    disabled
                >
                    ${icons.retry}
                    <span>Retry</span>
                </button>
                ${showHangup ? `
                    <button
                        class="stage-control hangup-control"
                        data-call-role="hangup"
                        type="button"
                        aria-label="Hang up"
                        title="Hang up"
                        disabled
                    >
                        ${icons.hangup}
                        <span class="visually-hidden">Hang up</span>
                    </button>
                ` : ""}
            </div>

            <button
                class="start-call-button"
                data-call-role="primary-action"
                type="button"
            >${actionLabel}</button>
        </div>
    `;

    const view = {
        eventCount: element(root, "event-count"),
        events: element(root, "events"),
        eventsClose: element(root, "events-close"),
        eventsDrawer: element(root, "events-drawer"),
        eventsToggle: element(root, "events-toggle"),
        hangupButton: element(root, "hangup"),
        cameraButton: element(root, "camera"),
        localAudioMeter: element(root, "local-audio-meter"),
        localVideo: element(root, "local-video"),
        muteButton: element(root, "mute"),
        participant: element(root, "participant"),
        primaryButton: element(root, "primary-action"),
        remoteVideo: element(root, "remote-video"),
        remoteAudioMeter: element(root, "remote-audio-meter"),
        retryButton: element(root, "retry")
    };

    const setEventsOpen = open => {
        if (!view.eventsDrawer) {
            return;
        }
        view.eventsDrawer.hidden = !open;
        view.eventsToggle.setAttribute("aria-expanded", String(open));
    };

    view.eventsToggle?.addEventListener("click", () => {
        setEventsOpen(view.eventsToggle.getAttribute("aria-expanded") !== "true");
    });
    view.eventsClose?.addEventListener("click", () => setEventsOpen(false));

    return {
        ...view,
        setEventsOpen,
        setParticipant(value) {
            view.participant.textContent = value;
        },
        setLocalMediaState({
            audioAvailable,
            audioEnabled,
            videoAvailable,
            videoEnabled
        }) {
            if (view.muteButton) {
                view.muteButton.disabled = !audioAvailable;
                view.muteButton.classList.toggle("is-off", !audioEnabled);
                view.muteButton.setAttribute("aria-pressed", String(!audioEnabled));
                const microphoneLabel = audioEnabled
                    ? "Mute microphone"
                    : "Unmute microphone";
                view.muteButton.setAttribute("aria-label", microphoneLabel);
                view.muteButton.title = microphoneLabel;
            }
            view.localAudioMeter.classList.toggle(
                "is-muted",
                !audioAvailable || !audioEnabled
            );

            if (view.cameraButton) {
                view.cameraButton.disabled = !videoAvailable;
                view.cameraButton.classList.toggle("is-off", !videoEnabled);
                view.cameraButton.setAttribute("aria-pressed", String(!videoEnabled));
                const cameraLabel = videoEnabled ? "Hide camera" : "Show camera";
                view.cameraButton.setAttribute("aria-label", cameraLabel);
                view.cameraButton.title = cameraLabel;
            }
            root.classList.toggle("local-audio-only", !videoAvailable);
            root.classList.toggle("local-camera-off", videoAvailable && !videoEnabled);
        },
        setRemoteMediaState({ audioEnabled = true, videoAvailable = true, videoEnabled = true }) {
            view.remoteAudioMeter.classList.toggle("is-muted", !audioEnabled);
            root.classList.toggle("remote-audio-only", !videoAvailable);
            root.classList.toggle("remote-camera-off", videoAvailable && !videoEnabled);
        }
    };
}
