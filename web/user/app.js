import { connectSignaling } from "/shared/signaling.js";
import {
    createAudioMeter,
    createPeerConnection,
    openLocalMedia,
    resumeAudioMeters
} from "/shared/webrtc.js";
import { mountVideoCall } from "/shared/video-call.js";

const callView = mountVideoCall(document.getElementById("video-call-root"), {
    actionLabel: "Join call",
    participantLabel: "Operator",
    showHangup: false,
    showMediaControls: false
});
const localVideo = callView.localVideo;
const remoteVideo = callView.remoteVideo;
const status = document.getElementById("status");
const joinButton = callView.primaryButton;
const retryButton = callView.retryButton;

let pc = null;
let socket = null;
let localStream = null;
let localMediaPromise = null;
let pendingCandidates = [];
let mediaGeneration = 0;
let peerReady = false;
let remoteStream = null;
let localMeter = null;
let remoteMeter = null;
let requestedMedia = { audio: true, video: true };

callView.setLocalMediaState({
    audioAvailable: false,
    audioEnabled: false,
    videoAvailable: false,
    videoEnabled: false
});

// Delivery puts the one-time challenge in the fragment so it is not sent in
// the HTTP request or proxy logs. Remove it from the visible URL immediately.
const fragment = window.location.hash.slice(1);
const fragmentParameters = new URLSearchParams(fragment);
const solvedChallenge =
    fragmentParameters.get("challenge") ||
    fragmentParameters.get("invite") ||
    (fragment.includes("=") ? "" : decodeURIComponent(fragment));
history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);

function setStatus(value) {
    status.textContent = value;
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
    localMediaPromise = null;
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

function ensurePeerConnection() {
    if (!pc || pc.signalingState === "closed") {
        return resetPeerConnection();
    }
    return pc;
}

function ensureLocalMedia() {
    const connection = ensurePeerConnection();
    const generation = mediaGeneration;

    if (!localMediaPromise) {
        localMediaPromise = openLocalMedia(
            connection,
            localVideo,
            requestedMedia
        )
            .then(stream => {
                if (
                    generation !== mediaGeneration ||
                    pc !== connection ||
                    connection.signalingState === "closed"
                ) {
                    stopStream(stream);
                    return null;
                }

                localStream = stream;
                localMeter?.stop();
                localMeter = createAudioMeter(stream, callView.localAudioMeter);
                updateLocalMediaControls();
                sendLocalMediaStatus();
                setStatus(requestedMedia.video
                    ? "Microphone and camera ready"
                    : "Microphone ready"
                );
                console.log(
                    "User audio tracks:",
                    stream.getAudioTracks().map(track => ({
                        label: track.label,
                        enabled: track.enabled,
                        muted: track.muted,
                        readyState: track.readyState,
                        settings: track.getSettings()
                    }))
                );
                console.log(
                    "User senders:",
                    connection.getSenders().map(sender => sender.track?.kind)
                );
                return stream;
            })
            .catch(error => {
                if (generation === mediaGeneration) {
                    localMediaPromise = null;
                }
                throw error;
            });
    }

    return localMediaPromise;
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
    if (!connection || !connection.remoteDescription) {
        pendingCandidates.push(candidate);
        return;
    }

    try {
        await connection.addIceCandidate(candidate);
    } catch (error) {
        console.warn("Ignoring stale ICE candidate:", error);
    }
}

async function handleMessage(message) {
    console.log("User received:", message);

    if (message.type === "offer.status") {
        setStatus(`${message.payload.state} (${message.payload.http_status})`);
        if (message.payload.state.endsWith(".failed")) {
            retryButton.disabled = !peerReady;
        }
        return;
    }

    if (message.type === "peer-ready") {
        requestedMedia = {
            audio: message.payload?.media?.audio !== false,
            video: message.payload?.media?.video !== false
        };
        peerReady = true;
        setStatus(requestedMedia.video
            ? "Operator requested microphone and camera access"
            : "Operator requested microphone access"
        );
        retryButton.disabled = false;
        resetPeerConnection();
        callView.setRemoteMediaState({
            audioEnabled: true,
            videoAvailable: true,
            videoEnabled: true
        });
        await ensureLocalMedia();
        return;
    }

    if (message.type === "peer-retry") {
        peerReady = true;
        setStatus("Restarting media");
        retryButton.disabled = true;
        resetPeerConnection();
        await ensureLocalMedia();
        retryButton.disabled = false;
        return;
    }

    if (message.type === "video-offer") {
        const connection = ensurePeerConnection();
        await connection.setRemoteDescription(
            new RTCSessionDescription(message.payload)
        );
        await flushPendingCandidates(connection);
        await ensureLocalMedia();

        if (connection.signalingState === "closed" || pc !== connection) {
            return;
        }
        const answerDescription = await connection.createAnswer();
        await connection.setLocalDescription(answerDescription);
        socket.send("video-answer", connection.localDescription);
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

if (!solvedChallenge) {
    joinButton.disabled = true;
    setStatus("Invitation is missing or invalid");
}

joinButton.addEventListener("click", () => {
    resumeAudioMeters();
    joinButton.disabled = true;
    setStatus("Connecting");
    resetPeerConnection();

    socket = connectSignaling({
        id: "user-1",
        role: "user",

        onOpen(signaling) {
            setStatus("Verifying invitation");
            signaling.send("join.offer", {
                solved_challenge: solvedChallenge
            });
        },

        onMessage(message) {
            handleMessage(message).catch(error => {
                console.error("Signaling message failed:", error);
                setStatus("Media setup failed — retry available");
                retryButton.disabled = !peerReady;
            });
        },

        onClose() {
            peerReady = false;
            disposePeerConnection();
            setStatus("Disconnected");
            retryButton.disabled = true;
        },

        onError() {
            setStatus("Signaling connection error");
            retryButton.disabled = !peerReady;
        }
    });
});

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

retryButton.addEventListener("click", () => {
    resumeAudioMeters();
    if (!peerReady || socket?.readyState !== WebSocket.OPEN) {
        setStatus("Ask the operator to restart the invitation");
        retryButton.disabled = true;
        return;
    }

    retryButton.disabled = true;
    setStatus("Requesting media restart");
    socket.send("peer-retry-request");
});

window.addEventListener("pagehide", disposePeerConnection);
