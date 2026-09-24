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

export const PREVIEW_TRACK_LIMIT = 3;

// A 30-second clip of one of the artist's top tracks. Deezer signs these URLs and they expire
// after roughly half an hour, so clients should refresh them before playing a stale one.
export type TrackPreview = {
  id: string;
  title: string;
  url: string;
};

export type ArtistNeighborhood = {
  artist: ArtistSummary;
  related: ArtistSummary[];
  previews: TrackPreview[];
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

export type ArtistPreviewsResult =
  | {
      ok: true;
      data: TrackPreview[];
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
