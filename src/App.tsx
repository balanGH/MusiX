import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Processing from './pages/Processing';
import Player from './pages/Player';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/processing/:jobId" element={<Processing />} />
        <Route path="/player/:jobId" element={<Player />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
