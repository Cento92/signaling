export function connectSignaling({ url, id, role, onMessage, onOpen, onClose, onError }) {
    if (!url) {
        const protocol =
            window.location.protocol === "https:" ? "wss:" : "ws:";
        url = `${protocol}//${window.location.host}/ws`;
    }
    const socket = new WebSocket(url);

    const signaling = {
        send(type, payload) {
            if (socket.readyState !== WebSocket.OPEN) {
                throw new Error("Cannot send signaling message: connection is not open");
            }

            const message = { type };

            if (payload !== undefined) {
                message.payload = payload;
            }

            socket.send(JSON.stringify(message));
        },

        close(code, reason) {
            socket.close(code, reason);
        },

        get readyState() {
            return socket.readyState;
        }
    };

    socket.addEventListener("open", () => {
        signaling.send("connect", {
            id,
            role
        });

        if (onOpen) {
            onOpen(signaling);
        }
    });

    socket.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        onMessage(message, signaling);
    });

    socket.addEventListener("close", event => {
        console.log("Signalling closed:", event.code, event.reason);

        if (onClose) {
            onClose(event, signaling);
        }
    });

    socket.addEventListener("error", event => {
        if (onError) {
            onError(event, signaling);
        }
    });

    return signaling;
}
