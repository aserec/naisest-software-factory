import { fakeCi } from "../fakes";
import { ciContract } from "./ci.contract";

ciContract(async () => ({ ci: fakeCi({ vars: { ticket: "8" }, secrets: { FACTORY_GITLAB_TOKEN: "glpat-fake" } }), ticket: "8", secret: "FACTORY_GITLAB_TOKEN", foreignRun: "99" }));
