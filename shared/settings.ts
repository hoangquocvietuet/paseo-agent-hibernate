import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const hibernateSettings = defineSettings({
  id: "hibernate",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Run the periodic scan. Manual scans from the dashboard ignore this switch. */
    enabled: z.boolean().default(true),
    /** Hours without activity before an idle agent is archived. */
    idleHours: z.number().positive().default(12),
  }),
});
