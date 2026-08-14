const { WebSocketServer } = require("ws");

const chatGateway = require("./chatrooms_ws");
const marketGateway = require("./marketData_ws");
const futuresGateway = require("./futuresLive_ws");
const socialGateway = require("./websocketService");

function attachWebSocketManager(server) {

    const chatWss = new WebSocketServer({ noServer: true });
    const marketWss = new WebSocketServer({ noServer: true });
    const futuresWss = new WebSocketServer({ noServer: true });
    const socialWss = new WebSocketServer({ noServer: true });

    chatGateway.initialize(chatWss);
    marketGateway.initialize(marketWss);
    futuresGateway.initialize(futuresWss);
    socialGateway.initialize(socialWss);

    server.on("upgrade", (req, socket, head) => {

        let pathname;

        try {

            pathname = new URL(
                req.url,
                `http://${req.headers.host}`
            ).pathname;

        } catch (err) {

            console.error("[WS] Invalid URL:", err);

            socket.destroy();

            return;
        }

        try {

            switch (pathname) {

                case "/ws/chat":

                    chatWss.handleUpgrade(req, socket, head, (ws) => {

                        chatWss.emit("connection", ws, req);

                    });

                    break;

                case marketGateway.WS_PATH:

                    marketWss.handleUpgrade(req, socket, head, (ws) => {

                        marketWss.emit("connection", ws, req);

                    });

                    break;

                case futuresGateway.WS_PATH:

                    futuresWss.handleUpgrade(req, socket, head, (ws) => {

                        futuresWss.emit("connection", ws, req);

                    });

                    break;

                case socialGateway.WS_PATH:

                    socialWss.handleUpgrade(req, socket, head, (ws) => {

                        socialWss.emit("connection", ws, req);

                    });

                    break;

                default:

                    socket.destroy();

            }

        } catch (err) {

            console.error("[WS] Upgrade failed:", err);

            socket.destroy();

        }

    });

}

module.exports = attachWebSocketManager;