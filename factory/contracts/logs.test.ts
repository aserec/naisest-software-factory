import { makeFileLogs } from "../adapters/file-logs";
import { fakeLogs } from "../fakes";
import { logsContract } from "./logs.contract";

const group = (fingerprint: string, hourly: number[]) => ({ fingerprint, message: "boom", hourly, firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: new Date().toISOString(), samples: [], link: "x" });
logsContract(() => fakeLogs([group("aaa", Array(24).fill(1)), group("bbb", Array(24).fill(0))]));
logsContract(() => makeFileLogs("watcher/fixtures"));
