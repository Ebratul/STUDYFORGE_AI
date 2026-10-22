import bn from "@/messages/bn.json";
import type { Catalog } from "./translate";
import type { Locale } from "./config";

export const catalogs: Partial<Record<Locale, Catalog>> = { bn: bn as Catalog };
