/**
 * Layout math for `VirtualGrid`, kept pure so it can be tested without a DOM.
 */

export interface GridLayout {
  columns: number;
  /** Actual tile width — at least `minTileWidth` unless the container is narrower. */
  tileWidth: number;
  /** Tile height: a square cover the width of the tile, plus the caption. */
  tileHeight: number;
  /** Distance from one row's top to the next. */
  stride: number;
}

/**
 * @param contentWidth the container's width *inside its padding* — tiles are
 *   positioned in the content box, so measuring `clientWidth` (which includes
 *   padding) makes the last column spill past the edge.
 */
export function computeGridLayout(
  contentWidth: number,
  minTileWidth: number,
  gap: number,
  captionHeight: number,
): GridLayout {
  const width = Math.max(0, contentWidth);
  const columns = Math.max(1, Math.floor((width + gap) / (minTileWidth + gap)));
  const tileWidth = Math.max(0, (width - gap * (columns - 1)) / columns);
  // Tiles stretch past `minTileWidth` to fill the row, and the cover is square,
  // so the row height has to follow the *actual* width — a fixed
  // `minTileWidth + caption` makes stretched covers overlap the next row.
  const tileHeight = tileWidth + captionHeight;
  return { columns, tileWidth, tileHeight, stride: tileHeight + gap };
}

/** Width of an element's content box (inside padding, excluding the scrollbar). */
export function contentBoxWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const padding =
    (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  return Math.max(0, element.clientWidth - padding);
}
