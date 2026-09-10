const configuration = {
    iceServers: [
        {
            urls: [
                "stun:stun1.l.google.com:19302",
                "stun:stun2.l.google.com:19302"
            ]
        },
        {
          urls: "turn:turn.cento92.com:3478",
          username: "Rounding8085",
          credential: "AGN&&My4Zxt6@w6bUmxtJ2yBmTa%*^"
        },
    ],
    // iceTransportPolicy: "relay",
    iceCandidatePoolSize: 10
};

export function createPeerConnection() {
    return new RTCPeerConnection(configuration);
}

export async function openLocalMedia(
    peerConnection,
    videoElement,
    constraints = { audio: true, video: true }
) {
    try {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error(
                `getUserMedia unavailable; secure context: ${window.isSecureContext}`
            );
        }

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: constraints.audio !== false,
            video: constraints.video !== false
        });

        // Permission prompts are asynchronous. A Retry or Hang up may have
        // closed this peer while the browser was waiting for the user.
        if (peerConnection.signalingState === "closed") {
            stream.getTracks().forEach(track => track.stop());
            throw new DOMException(
                "The media session was replaced while permission was pending",
                "InvalidStateError"
            );
        }

        videoElement.srcObject = stream;

        console.log("Got MediaStream:", stream);
        console.log("MediaStream Tracks:", stream.getTracks());

        for (const track of stream.getTracks()) {
            peerConnection.addTrack(track, stream);
        }

        return stream;
    } catch (error) {
        console.error("Error opening camera/microphone:", error);

        // Callers need the rejection to expose Retry instead of continuing to
        // create an offer on an unusable peer connection.
        throw error;
    }
}

let sharedAudioContext = null;

function getAudioMeterContext() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
        return null;
    }
    if (!sharedAudioContext || sharedAudioContext.state === "closed") {
        sharedAudioContext = new AudioContext();
    }
    return sharedAudioContext;
}

export function resumeAudioMeters() {
    const context = getAudioMeterContext();
    return context?.resume().catch(() => {});
}

export function createAudioMeter(stream, element) {
    const context = getAudioMeterContext();
    const audioTrack = stream?.getAudioTracks()[0];
    if (!context || !audioTrack || !element) {
        return { stop() {} };
    }

    const source = context.createMediaStreamSource(
        new MediaStream([audioTrack])
    );
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);

    const samples = new Uint8Array(analyser.fftSize);
    const bars = [...element.querySelectorAll("[data-meter-bar]")];
    const activityTarget = element.closest(".local-preview, .participant-badge");
    let animationFrame = 0;
    let stopped = false;
    let speaking = false;
    let loudFrames = 0;
    let quietFrames = 0;

    element.dataset.active = "true";
    context.resume().catch(() => {});

    const setSpeaking = value => {
        if (speaking === value) {
            return;
        }
        speaking = value;
        element.dataset.speaking = String(value);
        activityTarget?.classList.toggle("is-speaking", value);
    };

    const draw = () => {
        if (stopped) {
            return;
        }

        analyser.getByteTimeDomainData(samples);
        let sumSquares = 0;
        for (const sample of samples) {
            const normalized = (sample - 128) / 128;
            sumSquares += normalized * normalized;
        }
        const level = Math.min(1, Math.sqrt(sumSquares / samples.length) * 5);

        bars.forEach((bar, index) => {
            const distanceFromCenter = Math.abs(index - (bars.length - 1) / 2);
            const scale = Math.max(
                0.18,
                Math.min(1, level * 1.45 - distanceFromCenter * 0.1)
            );
            bar.style.transform = `scaleY(${scale})`;
        });
        if (level > 0.08) {
            loudFrames += 1;
            quietFrames = 0;
            if (loudFrames >= 2) {
                setSpeaking(true);
            }
        } else {
            quietFrames += 1;
            loudFrames = 0;
            if (quietFrames >= 10) {
                setSpeaking(false);
            }
        }
        animationFrame = window.requestAnimationFrame(draw);
    };
    draw();

    return {
        stop() {
            if (stopped) {
                return;
            }
            stopped = true;
            window.cancelAnimationFrame(animationFrame);
            source.disconnect();
            analyser.disconnect();
            setSpeaking(false);
            bars.forEach(bar => {
                bar.style.transform = "scaleY(0.18)";
            });
            delete element.dataset.active;
            delete element.dataset.speaking;
        }
    };
}
