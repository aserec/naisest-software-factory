import { describe } from "vitest";
import { makeTeamsChat } from "../adapters/teams-chat";
import { chatContract } from "./chat.contract";

// Manual job only (contract-real in .gitlab-ci.yml): it posts real cards to a Teams test channel.
describe.skipIf(!process.env.FACTORY_CONTRACT_REAL)("real Teams chat", () => {
  chatContract(
    () => makeTeamsChat(process.env.CONTRACT_TEAMS_WEBHOOK_URL!),
    () => ({ chat: makeTeamsChat("https://contract-secret.invalid/hook"), secret: "contract-secret" }),
  );
});
