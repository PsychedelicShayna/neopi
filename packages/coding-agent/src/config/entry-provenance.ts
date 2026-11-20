import { createProvenanceLookup } from "@oh-my-pi/pi-tui/theme/provenance";
import data from "./entry-provenance.json" with { type: "json" };

export const entryProvenance = createProvenanceLookup(data);
