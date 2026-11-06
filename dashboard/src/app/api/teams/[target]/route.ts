import { handleTeams } from "@/server/teams-bridge";

// The Teams inbound bridge: one Teams outgoing webhook per target posts here. See server/teams-bridge.ts.
export async function POST(req: Request, { params }: { params: Promise<{ target: string }> }) {
  return handleTeams(req, (await params).target);
}
