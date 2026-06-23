import { Route, Routes } from "react-router-dom";
import AppShell from "./components/AppShell";
import Home from "./screens/Home";
import MapScreen from "./screens/Map";
import ServiceDetail from "./screens/ServiceDetail";
import Changes from "./screens/Changes";
import Copilot from "./screens/Copilot";
import Networking from "./screens/Networking";
import Storage from "./screens/Storage";
import Images from "./screens/Images";
import Logs from "./screens/Logs";
import Compose from "./screens/Compose";
import NotFound from "./screens/NotFound";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="map" element={<MapScreen />} />
        <Route path="services/:name" element={<ServiceDetail />} />
        <Route path="changes" element={<Changes />} />
        <Route path="copilot" element={<Copilot />} />
        <Route path="networking" element={<Networking />} />
        <Route path="storage" element={<Storage />} />
        <Route path="images" element={<Images />} />
        <Route path="logs" element={<Logs />} />
        <Route path="compose" element={<Compose />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
