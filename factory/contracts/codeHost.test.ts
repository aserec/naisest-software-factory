import { fakeCodeHost } from "../fakes";
import { codeHostContract } from "./codeHost.contract";

codeHostContract(async () => ({ host: fakeCodeHost({ head: "head1" }), branch: "factory/8-x", ticket: "8" }));
