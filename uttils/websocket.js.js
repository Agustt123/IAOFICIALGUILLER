let wss;

export function setWSServer(server) {
    wss = server;
}

export function sendNotificationToAll(notification) {
    if (!wss) return;

    wss.clients.forEach((client) => {
        if (client.readyState === 1) {
            client.send(JSON.stringify(notification));
        }
    });
}
