export const KENDRICK_LAMAR_ID = "525046";
export const ROOT_RELATED_ARTIST_LIMIT = 5;
export const RELATED_ARTIST_LIMIT = 3;
export const ARTIST_SEARCH_LIMIT = 8;

export type ArtistSummary = {
  id: string;
  name: string;
  imageUrl?: string;
  url?: string;
  fans?: number;
};

export type ArtistNeighborhood = {
  artist: ArtistSummary;
  related: ArtistSummary[];
};

export type ArtistNeighborhoodResult =
  | {
      ok: true;
      data: ArtistNeighborhood;
    }
  | {
      ok: false;
      error: string;
    };

export type ArtistSearchResult =
  | {
      ok: true;
      data: ArtistSummary[];
    }
  | {
      ok: false;
      error: string;
    };

export const kendrickLamarFallback: ArtistSummary = {
  id: KENDRICK_LAMAR_ID,
  name: "Kendrick Lamar",
  url: "https://www.deezer.com/artist/525046"
};
