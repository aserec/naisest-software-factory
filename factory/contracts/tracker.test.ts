import { fakeTracker } from "../fakes";
import { trackerContract } from "./tracker.contract";

trackerContract(async () => ({ tracker: fakeTracker([{ ref: "1", title: "T" }]), ref: "1" }));
