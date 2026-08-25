/**
 * Routing.
 *
 * Every page lives under `AppShell`, so the player bar and the audio graph are
 * mounted once and survive navigation. Heavy, rarely-opened pages are lazily
 * loaded so they do not sit in the startup bundle (spec §35).
 */

import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { ErrorBoundary } from './ErrorBoundary';
import { Spinner } from '@ui/primitives';

// Eager: these are the first screens a user sees.
import { HomePage } from '@features/home/HomePage';
import { WelcomePage } from '@features/onboarding/WelcomePage';
import { SongsPage } from '@features/songs/SongsPage';

// Lazy: opened on demand, and each pulls in something substantial —
// the album grid, the health scan, the equaliser's canvas, the studio client.
const AlbumsPage = lazy(() =>
  import('@features/albums/AlbumsPage').then((m) => ({ default: m.AlbumsPage })),
);
const AlbumPage = lazy(() =>
  import('@features/albums/AlbumPage').then((m) => ({ default: m.AlbumPage })),
);
const ArtistsPage = lazy(() =>
  import('@features/artists/ArtistsPage').then((m) => ({ default: m.ArtistsPage })),
);
const ArtistPage = lazy(() =>
  import('@features/artists/ArtistPage').then((m) => ({ default: m.ArtistPage })),
);
const FoldersPage = lazy(() =>
  import('@features/folders/FoldersPage').then((m) => ({ default: m.FoldersPage })),
);
const FavoritesPage = lazy(() =>
  import('@features/favorites/FavoritesPage').then((m) => ({ default: m.FavoritesPage })),
);
const PlaylistsPage = lazy(() =>
  import('@features/playlists/PlaylistsPage').then((m) => ({ default: m.PlaylistsPage })),
);
const PlaylistPage = lazy(() =>
  import('@features/playlists/PlaylistPage').then((m) => ({ default: m.PlaylistPage })),
);
const SearchPage = lazy(() =>
  import('@features/search/SearchPage').then((m) => ({ default: m.SearchPage })),
);
const EqualizerPage = lazy(() =>
  import('@features/equalizer/EqualizerPage').then((m) => ({ default: m.EqualizerPage })),
);
const HealthPage = lazy(() =>
  import('@features/health/HealthPage').then((m) => ({ default: m.HealthPage })),
);
const SettingsPage = lazy(() =>
  import('@features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const StudioPage = lazy(() =>
  import('@features/studio/StudioPage').then((m) => ({ default: m.StudioPage })),
);

function PageFallback() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Spinner size={20} />
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/songs" element={<SongsPage />} />

            <Route
              path="/albums"
              element={
                <Suspense fallback={<PageFallback />}>
                  <AlbumsPage />
                </Suspense>
              }
            />
            <Route
              path="/albums/:albumId"
              element={
                <Suspense fallback={<PageFallback />}>
                  <AlbumPage />
                </Suspense>
              }
            />
            <Route
              path="/artists"
              element={
                <Suspense fallback={<PageFallback />}>
                  <ArtistsPage />
                </Suspense>
              }
            />
            <Route
              path="/artists/:artistId"
              element={
                <Suspense fallback={<PageFallback />}>
                  <ArtistPage />
                </Suspense>
              }
            />
            <Route
              path="/folders"
              element={
                <Suspense fallback={<PageFallback />}>
                  <FoldersPage />
                </Suspense>
              }
            />
            <Route
              path="/favorites"
              element={
                <Suspense fallback={<PageFallback />}>
                  <FavoritesPage />
                </Suspense>
              }
            />
            <Route
              path="/playlists"
              element={
                <Suspense fallback={<PageFallback />}>
                  <PlaylistsPage />
                </Suspense>
              }
            />
            <Route
              path="/playlists/:playlistId"
              element={
                <Suspense fallback={<PageFallback />}>
                  <PlaylistPage />
                </Suspense>
              }
            />
            <Route
              path="/search"
              element={
                <Suspense fallback={<PageFallback />}>
                  <SearchPage />
                </Suspense>
              }
            />
            <Route
              path="/equalizer"
              element={
                <Suspense fallback={<PageFallback />}>
                  <EqualizerPage />
                </Suspense>
              }
            />
            <Route
              path="/health"
              element={
                <Suspense fallback={<PageFallback />}>
                  <HealthPage />
                </Suspense>
              }
            />
            <Route
              path="/settings"
              element={
                <Suspense fallback={<PageFallback />}>
                  <SettingsPage />
                </Suspense>
              }
            />
            <Route
              path="/studio"
              element={
                <Suspense fallback={<PageFallback />}>
                  <StudioPage />
                </Suspense>
              }
            />

            {/* Unknown paths go home rather than showing a 404 in an app shell. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
