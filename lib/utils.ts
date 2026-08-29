import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class lists without the usual specificity foot-guns. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
