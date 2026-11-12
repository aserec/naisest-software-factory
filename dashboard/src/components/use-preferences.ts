"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { translator } from "@/lib/i18n";
import type { Me, Prefs } from "@/lib/preferences";

const KEY = ["preferences"];

// The signed-in user and their saved preferences. save() shows the change at once and puts it back if the server refuses it.
export function usePreferences() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const r = await api("/api/preferences");
      if (!r.ok) throw new Error(`Preferences answered ${r.status}`);
      return (await r.json()) as Me;
    },
  });
  const save = useMutation({
    mutationFn: async (change: Partial<Prefs>) => {
      const r = await api("/api/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
      if (!r.ok) throw new Error((await r.text()) || `Saving answered ${r.status}`);
    },
    onMutate: (change) => {
      const before = client.getQueryData<Me>(KEY);
      if (before) client.setQueryData<Me>(KEY, { ...before, prefs: { ...before.prefs, ...change } });
      return before;
    },
    onError: (_e, _change, before) => before && client.setQueryData(KEY, before),
  });
  return { query, me: query.data, prefs: query.data?.prefs, save };
}

// t("English text", { name: value }) in the signed-in person's language. English until the preferences load.
export function useT() {
  return translator(usePreferences().prefs?.language ?? "en");
}
