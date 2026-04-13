import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORE_PATH = path.join(__dirname, "device-tokens.json");

function loadTokens() {
    try {
        if (!fs.existsSync(STORE_PATH)) return new Set();
        const raw = fs.readFileSync(STORE_PATH, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.map((token) => String(token)).filter(Boolean));
    } catch (error) {
        console.error("Error cargando tokens persistidos:", error);
        return new Set();
    }
}

function persistTokens(tokens) {
    try {
        fs.writeFileSync(
            STORE_PATH,
            JSON.stringify([...tokens], null, 2),
            "utf8"
        );
    } catch (error) {
        console.error("Error guardando tokens persistidos:", error);
    }
}

const tokens = loadTokens();

export const deviceStore = {
    tokens,
    getAll() {
        return [...tokens];
    },
    add(token) {
        const normalized = String(token || "").trim();
        if (!normalized) return false;
        const before = tokens.size;
        tokens.add(normalized);
        if (tokens.size !== before) {
            persistTokens(tokens);
            return true;
        }
        return false;
    },
    delete(token) {
        const removed = tokens.delete(String(token));
        if (removed) persistTokens(tokens);
        return removed;
    },
    clear() {
        const total = tokens.size;
        tokens.clear();
        persistTokens(tokens);
        return total;
    },
};
