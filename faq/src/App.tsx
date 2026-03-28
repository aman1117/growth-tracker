import { Footer } from './components/Footer.tsx';
import { Header } from './components/Header.tsx';
import { HelpPage } from './components/HelpPage.tsx';

export function App() {
  return (
    <div className="help-layout">
      <Header />
      <HelpPage />
      <Footer />
    </div>
  );
}
