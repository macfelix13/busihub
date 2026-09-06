import {
  Scissors,
  Droplet,
  Droplets,
  Paintbrush,
  Palette,
  Flower2,
  Heart,
  Gem,
  Sparkles,
  Sun,
  Wind,
  Feather,
  Hand,
  Smile,
  Bath,
  SprayCan,
  Scale,
  Package,
  Tag,
  ShoppingBag,
  Star,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * The ONLY icons a category can use — lucide-react is the project's one
 * icon library (Section: code quality review confirmed no other icon
 * package is installed), and a category's icon is stored as a plain
 * string name (categories.icon), never markup, so this allowlist is what
 * stands between that column and arbitrary/unverified icon names. A name
 * outside this list is rejected by lib/validation/categories.ts before it
 * ever reaches the database — never trust a client-supplied string to
 * name a real component.
 *
 * Deliberately a curated subset, not "every lucide-react export": picked
 * for the categories a salon/service business actually reaches for
 * (Hair, Nails, Beauty, Grooming, Treatment) plus a few general-retail
 * options, not an exhaustive icon browser.
 */
export const CATEGORY_ICONS: { value: string; label: string; Icon: LucideIcon }[] = [
  { value: "Scissors", label: "Scissors", Icon: Scissors },
  { value: "Droplet", label: "Droplet", Icon: Droplet },
  { value: "Droplets", label: "Droplets", Icon: Droplets },
  { value: "Paintbrush", label: "Paintbrush", Icon: Paintbrush },
  { value: "Palette", label: "Palette", Icon: Palette },
  { value: "Flower2", label: "Flower", Icon: Flower2 },
  { value: "Heart", label: "Heart", Icon: Heart },
  { value: "Gem", label: "Gem", Icon: Gem },
  { value: "Sparkles", label: "Sparkles", Icon: Sparkles },
  { value: "Sun", label: "Sun", Icon: Sun },
  { value: "Wind", label: "Wind", Icon: Wind },
  { value: "Feather", label: "Feather", Icon: Feather },
  { value: "Hand", label: "Hand", Icon: Hand },
  { value: "Smile", label: "Smile", Icon: Smile },
  { value: "Bath", label: "Bath", Icon: Bath },
  { value: "SprayCan", label: "Spray", Icon: SprayCan },
  { value: "Scale", label: "Scale", Icon: Scale },
  { value: "Package", label: "Package", Icon: Package },
  { value: "Tag", label: "Tag", Icon: Tag },
  { value: "ShoppingBag", label: "Shopping bag", Icon: ShoppingBag },
  { value: "Star", label: "Star", Icon: Star },
  { value: "Zap", label: "Zap", Icon: Zap },
];

const CATEGORY_ICON_MAP = new Map(CATEGORY_ICONS.map((i) => [i.value, i.Icon]));
export const CATEGORY_ICON_VALUES = CATEGORY_ICONS.map((i) => i.value) as [string, ...string[]];

/** Looks up a category's icon component by its stored name — falls back to null for an unrecognized/blank name rather than guessing. */
export function categoryIconComponent(name: string | null | undefined): LucideIcon | null {
  if (!name) return null;
  return CATEGORY_ICON_MAP.get(name) ?? null;
}