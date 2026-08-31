import { connectSignaling } from "../shared/signaling.js";
import {
    createAudioMeter,
    createPeerConnection,
    openLocalMedia,
    resumeAudioMeters
} from "../shared/webrtc.js";
import { mountVideoCall } from "../shared/video-call.js";

export function mountOperatorCall(root, {
    signalingUrl,
    stylesheetUrl,
    embedded = false
} = {}) {
const document = root?.ownerDocument ?? window.document;
if (!root?.replaceChildren) {
    throw new TypeError("mountOperatorCall requires a DOM mount root");
}

const defaultSocketURL = new URL("../ws", import.meta.url);
defaultSocketURL.protocol = defaultSocketURL.protocol === "https:" ? "wss:" : "ws:";
signalingUrl ||= defaultSocketURL.href;

const appRoot = document.createElement("div");
appRoot.className = embedded ? "operator-embed-root" : "operator-page-root";
appRoot.innerHTML = `
    <main class="app-shell">
        <header class="app-header">
            <div class="status-badge" aria-label="Call status">
                <strong id="status" aria-live="polite">Disconnected</strong>
            </div>
        </header>

        <div id="video-call-root"></div>
    </main>

    <dialog class="dialer-dialog" id="dialer-dialog" aria-labelledby="dialer-title">
        <form class="dialer" id="dialer-form">
            <div class="dialer-heading">
                <div>
                    <p class="eyebrow">New call</p>
                    <h2 id="dialer-title">Who would you like to call?</h2>
                </div>
                <button class="icon-button dialog-close" id="close-dialer" type="button" aria-label="Close address book">&#215;</button>
            </div>

            <section class="address-book" aria-labelledby="recent-title">
                <div class="section-heading">
                    <h3 id="recent-title">Recent emails</h3>
                    <span id="recent-count">0 contacts</span>
                </div>
                <div class="recent-contacts" id="recent-contacts"></div>
                <p class="recent-empty" id="recent-empty">Email addresses you call will appear here.</p>
            </section>

            <div class="recipient-fields">
                <label class="field">
                    Email address
                    <input id="client-email" type="email" autocomplete="email" placeholder="person@example.com">
                </label>
                <div class="field-divider" aria-hidden="true"><span>or</span></div>
                <label class="field">
                    Phone number
                    <input id="client-phone" type="tel" autocomplete="tel" placeholder="+1 555 000 0000">
                </label>
            </div>

            <button class="media-mode-button" id="client-media-mode" type="button" aria-pressed="true">
                <strong>Client: audio + video</strong>
                <span>The client will be asked for microphone and camera access.</span>
            </button>
            <button class="place-call-button" id="place-call" type="submit">Call person</button>
        </form>
    </dialog>
`;

const children = [];
if (stylesheetUrl) {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = stylesheetUrl;
    children.push(stylesheet);
}
children.push(appRoot);
root.replaceChildren(...children);

const callView = mountVideoCall(appRoot.querySelector("#video-call-root"), {
    actionLabel: "Start call",
    participantLabel: "Choose someone to call",
    showEvents: true
});
const localVideo = callView.localVideo;
const remoteVideo = callView.remoteVideo;
const status = appRoot.querySelector("#status");
const events = callView.events;
const eventCount = callView.eventCount;
const joinButton = callView.primaryButton;
const retryButton = callView.retryButton;
const hangupButton = callView.hangupButton;
const phoneInput = appRoot.querySelector("#client-phone");
const emailInput = appRoot.querySelector("#client-email");
const dialerDialog = appRoot.querySelector("#dialer-dialog");
const dialerForm = appRoot.querySelector("#dialer-form");
const closeDialerButton = appRoot.querySelector("#close-dialer");
const recentContacts = appRoot.querySelector("#recent-contacts");
const recentCount = appRoot.querySelector("#recent-count");
const recentEmpty = appRoot.querySelector("#recent-empty");
const clientMediaModeButton = appRoot.querySelector("#client-media-mode");
const operatorID = `op-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;

const recentEmailsStorageKey = "signaling.recent-called-emails";
let recentCalledEmails = loadRecentEmails();

let pc = null;
let socket = null;
let localStream = null;
let pendingCandidates = [];
let socketGeneration = 0;
let mediaGeneration = 0;
let peerReady = false;
let operatorCapacityReached = false;
let remoteStream = null;
let localMeter = null;
let remoteMeter = null;
let clientMedia = { audio: true, video: true };

callView.setLocalMediaState({
    audioAvailable: false,
    audioEnabled: false,
    videoAvailable: false,
    videoEnabled: false
});

function renderClientMediaMode() {
    const title = clientMediaModeButton.querySelector("strong");
    const description = clientMediaModeButton.querySelector("span");
    clientMediaModeButton.setAttribute("aria-pressed", String(clientMedia.video));
    title.textContent = clientMedia.video
        ? "Client: audio + video"
        : "Client: audio only";
    description.textContent = clientMedia.video
        ? "The client will be asked for microphone and camera access."
        : "The client will only be asked for microphone access.";
}

function loadRecentEmails() {
    try {
        const stored = JSON.parse(localStorage.getItem(recentEmailsStorageKey));
        return Array.isArray(stored)
            ? stored.filter(value => typeof value === "string").slice(0, 8)
            : [];
    } catch {
        return [];
    }
}

function renderRecentEmails() {
    recentContacts.replaceChildren();
    recentEmpty.hidden = recentCalledEmails.length > 0;
    recentCount.textContent = `${recentCalledEmails.length} ${
        recentCalledEmails.length === 1 ? "contact" : "contacts"
    }`;

    for (const email of recentCalledEmails) {
        const button = document.createElement("button");
        button.className = "contact-button";
        button.type = "button";
        button.textContent = email;
        button.addEventListener("click", () => {
            emailInput.value = email;
            phoneInput.value = "";
            emailInput.focus();
        });
        recentContacts.append(button);
    }
}

function rememberEmail(email) {
    if (!email) {
        return;
    }

    recentCalledEmails = [
        email,
        ...recentCalledEmails.filter(value => value !== email)
    ].slice(0, 8);
    try {
        localStorage.setItem(recentEmailsStorageKey, JSON.stringify(recentCalledEmails));
    } catch {
        // A private browser session may make localStorage unavailable.
    }
    renderRecentEmails();
}

function openDialer() {
    renderRecentEmails();
    dialerDialog.showModal();
    window.requestAnimationFrame(() => {
        (recentCalledEmails.length ? recentContacts.firstElementChild : emailInput)?.focus();
    });
}

function setStatus(value) {
    status.textContent = value;
}

function record(message) {
    const item = document.createElement("li");
    const timestamp = document.createElement("time");
    const details = document.createElement("code");

    item.className = "event-item";
    timestamp.dateTime = new Date().toISOString();
    timestamp.textContent = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
    details.textContent = JSON.stringify(message);
    item.append(timestamp, details);
    events.append(item);
    const count = events.children.length;
    eventCount.textContent = String(count);
    events.scrollTop = events.scrollHeight;
}

function stopStream(stream) {
    stream?.getTracks().forEach(track => track.stop());
}

function disposePeerConnection() {
    mediaGeneration += 1;
    stopStream(localStream);
    localStream = null;
    remoteStream = null;
    localMeter?.stop();
    remoteMeter?.stop();
    localMeter = null;
    remoteMeter = null;
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    pendingCandidates = [];

    if (pc && pc.signalingState !== "closed") {
        pc.close();
    }
    pc = null;
    callView.setLocalMediaState({
        audioAvailable: false,
        audioEnabled: false,
        videoAvailable: false,
        videoEnabled: false
    });
}

function resetPeerConnection() {
    disposePeerConnection();
    const connection = createPeerConnection();
    pc = connection;

    connection.onicecandidate = event => {
        if (
            pc === connection &&
            event.candidate &&
            socket?.readyState === WebSocket.OPEN
        ) {
            socket.send("candidate", event.candidate);
        }
    };

    connection.ontrack = event => {
        if (pc !== connection) {
            return;
        }

        console.log("Operator received track:", {
            kind: event.track.kind,
            enabled: event.track.enabled,
            muted: event.track.muted,
            readyState: event.track.readyState
        });

        if (!remoteStream) {
            remoteStream = new MediaStream();
        }
        if (!remoteStream.getTracks().some(track => track.id === event.track.id)) {
            remoteStream.addTrack(event.track);
        }
        remoteVideo.srcObject = remoteStream;
        if (event.track.kind === "audio") {
            remoteMeter?.stop();
            remoteMeter = createAudioMeter(remoteStream, callView.remoteAudioMeter);
        }
        remoteVideo.muted = false;
        remoteVideo.volume = 1;
        remoteVideo.play().catch(error => {
            console.error("Remote playback blocked:", error);
        });
    };

    connection.onconnectionstatechange = () => {
        if (pc !== connection) {
            return;
        }
        if (connection.connectionState === "connected") {
            setStatus("Connected");
        }
        if (connection.connectionState === "failed") {
            setStatus("Media connection failed — retry available");
            retryButton.disabled = false;
        }
    };

    return connection;
}

async function flushPendingCandidates(connection) {
    const candidates = pendingCandidates;
    pendingCandidates = [];

    for (const candidate of candidates) {
        try {
            await connection.addIceCandidate(candidate);
        } catch (error) {
            console.warn("Ignoring stale ICE candidate:", error);
        }
    }
}

async function addRemoteCandidate(candidate) {
    const connection = pc;
    if (!connection || connection.signalingState === "closed") {
        pendingCandidates.push(candidate);
        return;
    }
    if (!connection.remoteDescription) {
        pendingCandidates.push(candidate);
        return;
    }

    try {
        await connection.addIceCandidate(candidate);
    } catch (error) {
        console.warn("Ignoring stale ICE candidate:", error);
    }
}

async function createAndSendOffer() {
    const connection = pc?.signalingState === "closed" || !pc
        ? resetPeerConnection()
        : pc;
    const generation = mediaGeneration;

    try {
        const stream = await openLocalMedia(connection, localVideo);
        if (
            generation !== mediaGeneration ||
            pc !== connection ||
            connection.signalingState === "closed"
        ) {
            stopStream(stream);
            return;
        }

        localStream = stream;
        localMeter?.stop();
        localMeter = createAudioMeter(stream, callView.localAudioMeter);
        updateLocalMediaControls();
        sendLocalMediaStatus();
        const offerDescription = await connection.createOffer();
        await connection.setLocalDescription(offerDescription);
        socket.send("video-offer", {
            sdp: offerDescription.sdp,
            type: offerDescription.type
        });
        setStatus("Calling client");
    } catch (error) {
        console.error("Could not start media negotiation:", error);
        setStatus("Media setup failed — retry available");
        retryButton.disabled = false;
    }
}

async function handleMessage(message) {
    console.log("Operator received:", message);
    record(message);

    if (message.type === "offer.status") {
        if (message.payload.state === "operator-capacity-reached") {
            operatorCapacityReached = true;
            setStatus("Full capacity — another operator is already connected");
            retryButton.disabled = false;
            hangupButton.disabled = true;
            return;
        }
        setStatus(`${message.payload.state} (${message.payload.http_status})`);
        if (message.payload.state.endsWith(".failed")) {
            retryButton.disabled = false;
        }
        return;
    }

    if (message.type === "peer-ready") {
        clientMedia = {
            audio: message.payload?.media?.audio !== false,
            video: message.payload?.media?.video !== false
        };
        peerReady = true;
        setStatus("Peer ready");
        hangupButton.disabled = false;
        retryButton.disabled = false;
        resetPeerConnection();
        callView.setRemoteMediaState({
            audioEnabled: true,
            videoAvailable: clientMedia.video,
            videoEnabled: clientMedia.video
        });
        await createAndSendOffer();
        return;
    }

    if (message.type === "video-answer") {
        const connection = pc;
        if (!connection || connection.signalingState === "closed") {
            setStatus("Media session closed — retry available");
            retryButton.disabled = false;
            return;
        }
        if (!connection.currentRemoteDescription) {
            const answer = new RTCSessionDescription(message.payload);
            await connection.setRemoteDescription(answer);
            await flushPendingCandidates(connection);
            setStatus("Connected");
        }
        return;
    }

    if (message.type === "peer-retry-request") {
        setStatus("Client requested a media restart");
        await retryConnection();
        return;
    }

    if (message.type === "media.status") {
        callView.setRemoteMediaState({
            audioEnabled: message.payload.audio_enabled !== false,
            videoAvailable: message.payload.video_available === true,
            videoEnabled: message.payload.video_enabled === true
        });
        return;
    }

    if (message.type === "candidate") {
        await addRemoteCandidate(message.payload);
    }
}

function startSignaling() {
    const clientPhone = phoneInput.value.trim();
    const clientEmail = emailInput.value.trim();
    if (!clientPhone && !clientEmail) {
        setStatus("Enter a client phone or email");
        emailInput.focus();
        return;
    }

    rememberEmail(clientEmail);
    callView.setParticipant(clientEmail || clientPhone);
    dialerDialog.close();

    socketGeneration += 1;
    const generation = socketGeneration;
    peerReady = false;
    operatorCapacityReached = false;
    socket?.close(1000, "operator restart");
    disposePeerConnection();

    joinButton.disabled = true;
    retryButton.disabled = false;
    hangupButton.disabled = false;
    setStatus("Connecting");

    socket = connectSignaling({
        url: signalingUrl,
        id: operatorID,
        role: "operator",

        onOpen(signaling) {
            if (generation !== socketGeneration) {
                signaling.close(1000, "superseded attempt");
                return;
            }
            setStatus("Creating invitation");
            signaling.send("join.offer", {
                client_phone: clientPhone,
                client_email: clientEmail,
                media: clientMedia
            });
        },

        onMessage(message) {
            if (generation !== socketGeneration) {
                return;
            }
            handleMessage(message).catch(error => {
                console.error("Signaling message failed:", error);
                setStatus("Protocol failed — retry available");
                retryButton.disabled = false;
            });
        },

        onClose() {
            if (generation !== socketGeneration) {
                return;
            }
            peerReady = false;
            disposePeerConnection();
            if (operatorCapacityReached) {
                setStatus("Full capacity — another operator is already connected");
                retryButton.disabled = false;
                hangupButton.disabled = true;
                return;
            }
            setStatus("Disconnected — retry available");
            retryButton.disabled = false;
            hangupButton.disabled = false;
        },

        onError() {
            if (generation !== socketGeneration) {
                return;
            }
            if (operatorCapacityReached) {
                return;
            }
            setStatus("Signaling connection error — retry available");
            retryButton.disabled = false;
        }
    });
}

function updateLocalMediaControls() {
    const audioTrack = localStream?.getAudioTracks()[0];
    const videoTrack = localStream?.getVideoTracks()[0];
    callView.setLocalMediaState({
        audioAvailable: Boolean(audioTrack),
        audioEnabled: Boolean(audioTrack?.enabled),
        videoAvailable: Boolean(videoTrack),
        videoEnabled: Boolean(videoTrack?.enabled)
    });
}

function sendLocalMediaStatus() {
    if (!peerReady || socket?.readyState !== WebSocket.OPEN) {
        return;
    }
    const audioTrack = localStream?.getAudioTracks()[0];
    const videoTrack = localStream?.getVideoTracks()[0];
    socket.send("media.status", {
        audio_enabled: Boolean(audioTrack?.enabled),
        video_available: Boolean(videoTrack),
        video_enabled: Boolean(videoTrack?.enabled)
    });
}

function toggleAudio() {
    const track = localStream?.getAudioTracks()[0];
    if (!track) {
        return;
    }
    track.enabled = !track.enabled;
    updateLocalMediaControls();
    sendLocalMediaStatus();
}

function toggleVideo() {
    const track = localStream?.getVideoTracks()[0];
    if (!track) {
        return;
    }
    track.enabled = !track.enabled;
    updateLocalMediaControls();
    sendLocalMediaStatus();
}

async function retryConnection() {
    retryButton.disabled = true;

    if (peerReady && socket?.readyState === WebSocket.OPEN) {
        setStatus("Restarting media");
        resetPeerConnection();
        socket.send("peer-retry");
        await createAndSendOffer();
        return;
    }

    startSignaling();
}

function hangUp() {
    socketGeneration += 1;
    peerReady = false;
    socket?.close(1000, "operator hangup");
    socket = null;
    disposePeerConnection();
    joinButton.disabled = false;
    retryButton.disabled = true;
    hangupButton.disabled = true;
    callView.setParticipant("Choose someone to call");
    setStatus("Disconnected");
}

renderRecentEmails();
renderClientMediaMode();
joinButton.addEventListener("click", openDialer);
clientMediaModeButton.addEventListener("click", () => {
    clientMedia = { audio: true, video: !clientMedia.video };
    renderClientMediaMode();
});
callView.muteButton.addEventListener("click", toggleAudio);
callView.cameraButton.addEventListener("click", toggleVideo);
closeDialerButton.addEventListener("click", () => dialerDialog.close());
dialerForm.addEventListener("submit", event => {
    event.preventDefault();
    resumeAudioMeters();
    startSignaling();
});
retryButton.addEventListener("click", () => {
    resumeAudioMeters();
    retryConnection().catch(error => {
        console.error("Retry failed:", error);
        setStatus("Retry failed");
        retryButton.disabled = false;
    });
});
hangupButton.addEventListener("click", hangUp);
window.addEventListener("pagehide", disposePeerConnection);

return () => {
    socketGeneration += 1;
    peerReady = false;
    window.removeEventListener("pagehide", disposePeerConnection);
    socket?.close(1000, "operator unmounted");
    socket = null;
    disposePeerConnection();
    root.replaceChildren();
};
}
