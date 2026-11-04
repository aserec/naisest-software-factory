import { ciContract } from "./ci.contract";
import { fakeCi } from "./fake-ci";

ciContract("fake", fakeCi, { listsJobs: true });
