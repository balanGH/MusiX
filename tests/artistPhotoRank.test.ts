import { describe, expect, it } from 'vitest';
import { rankDeezerArtists } from '@core/artists/onlinePhoto';

describe('rankDeezerArtists', () => {
  it('puts normalised exact-name matches first, most-followed first, then the rest', () => {
    const ranked = rankDeezerArtists('Na. Muthukumar', [
      { name: 'Someone Else', nb_fan: 9_000 },
      { name: 'Na Muthukumar', nb_fan: 10 },
      { name: 'Na.Muthukumar ', nb_fan: 500 },
      { name: 'Other', nb_fan: 20 },
    ]);
    expect(ranked.map((artist) => artist.name)).toEqual([
      'Na.Muthukumar ',
      'Na Muthukumar',
      'Someone Else',
      'Other',
    ]);
  });

  it('returns every candidate, so a second lookup has somewhere to go', () => {
    expect(rankDeezerArtists('x', [{ name: 'a' }, { name: 'b' }])).toHaveLength(2);
    expect(rankDeezerArtists('x', [])).toEqual([]);
  });
});
