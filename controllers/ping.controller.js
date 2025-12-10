export const ping = (req, res) => {
    return res.json({
        ok: true,
        msg: "pong",
        time: new Date().toISOString()
    });
};
