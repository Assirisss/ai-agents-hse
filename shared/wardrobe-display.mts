/** Internal image handles stay in tool data/history, never in conversational copy. */
export function wardrobeDisplayText(text: string): string {
  return text.replace(/`?\bcutout-[a-zA-Z0-9_-]{16,100}\b`?/g, 'фото без фона')
    .replace(/`?\b(?:stylist-|garment:)[a-zA-Z0-9_-]{16,100}\b`?/g, 'вещь в гардеробе')
}
