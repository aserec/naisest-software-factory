import { fakeTracker } from "./fake-tracker";
import { trackerContract } from "./tracker.contract";

trackerContract("fake", (seed, o) => ({ tracker: fakeTracker(seed, o), target: { name: "a", projectPath: "g/a", stuckMinutes: {}, tracker: "gitlab", codeHost: "gitlab" } }));
