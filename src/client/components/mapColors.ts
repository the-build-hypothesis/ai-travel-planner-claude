// Assigned to days in sequence. Checked with the palette validator on white (lightness, chroma,
// color-blind separation, contrast). The day number always accompanies the color.
export const DAY_COLORS = ['#2a78d6', '#eb6834', '#199e70', '#c98500', '#d55181', '#008300', '#6250d6', '#e34948'];
export const dayColor = (dayNumber: number) => DAY_COLORS[(dayNumber - 1) % DAY_COLORS.length];
