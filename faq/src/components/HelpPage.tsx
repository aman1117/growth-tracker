import { ArrowUp, Search, SearchX, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { FAQ_CATEGORIES } from '../constants/faq-content.ts';

import { FAQSection } from './FAQSection.tsx';

export function HelpPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [showBackToTop, setShowBackToTop] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setShowBackToTop(window.scrollY > 400);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const filteredCategories = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    let categories = FAQ_CATEGORIES;

    // Filter by active category chip
    if (activeCategory) {
      categories = categories.filter((c) => c.id === activeCategory);
    }

    // Filter by search query
    if (!query) return categories;

    return categories
      .map((category) => {
        const matchingItems = category.items.filter(
          (item) =>
            item.question.toLowerCase().includes(query) ||
            item.answer.toLowerCase().includes(query) ||
            item.steps?.some(
              (s) =>
                s.text.toLowerCase().includes(query) ||
                s.hint?.toLowerCase().includes(query),
            ),
        );
        if (matchingItems.length === 0) return null;
        return { ...category, items: matchingItems };
      })
      .filter(Boolean) as typeof categories;
  }, [searchQuery, activeCategory]);

  const matchedItemIds = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return undefined;
    const ids = new Set<string>();
    for (const cat of filteredCategories) {
      for (const item of cat.items) {
        ids.add(item.id);
      }
    }
    return ids;
  }, [searchQuery, filteredCategories]);

  const totalResults = filteredCategories.reduce(
    (sum, c) => sum + c.items.length,
    0,
  );

  return (
    <main className="help-main">
      {/* Hero */}
      <div className="help-hero">
        <h1 className="help-hero-title">How can we help?</h1>
        <p className="help-hero-subtitle">
          Find answers about installing Growth Tracker, setting up notifications, managing your account, and more.
        </p>
      </div>

      {/* Search */}
      <div className="help-search-wrapper">
        <Search size={18} className="help-search-icon" />
        <input
          type="search"
          className="help-search-input"
          placeholder="Search for help..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search frequently asked questions"
          autoComplete="off"
          spellCheck={false}
        />
        {searchQuery && (
          <button
            className="help-search-clear"
            onClick={() => setSearchQuery('')}
            aria-label="Clear search"
            type="button"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Category chips */}
      <div className="help-category-nav-wrapper">
        <nav className="help-category-nav" aria-label="FAQ categories">
        <button
          className="help-category-chip"
          data-active={!activeCategory}
          onClick={() => setActiveCategory(null)}
          type="button"
        >
          All
        </button>
        {FAQ_CATEGORIES.map((category) => {
          const Icon = category.icon;
          return (
            <button
              key={category.id}
              className="help-category-chip"
              data-active={activeCategory === category.id}
              onClick={() =>
                setActiveCategory(
                  activeCategory === category.id ? null : category.id,
                )
              }
              type="button"
            >
              <Icon size={14} />
              {category.label}
            </button>
          );
        })}
      </nav>
      </div>

      {/* Sections */}
      {filteredCategories.length > 0 ? (
        filteredCategories.map((category) => (
          <FAQSection
            key={category.id}
            category={category}
            expandedItemIds={matchedItemIds}
          />
        ))
      ) : (
        <div className="help-no-results">
          <SearchX size={48} className="help-no-results-icon" />
          <h2 className="help-no-results-title">No results found</h2>
          <p className="help-no-results-text">
            Try a different search term, or contact us at{' '}
            <a href="mailto:support@trackgrowth.in">support@trackgrowth.in</a>
          </p>
        </div>
      )}

      {/* Results count when searching */}
      {searchQuery && filteredCategories.length > 0 && (
        <p
          style={{
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: 'var(--text-sm)',
            marginTop: 'var(--space-4)',
          }}
        >
          Showing {totalResults} {totalResults === 1 ? 'result' : 'results'} for &ldquo;{searchQuery}&rdquo;
        </p>
      )}

      {/* Back to top */}
      <button
        className="help-back-to-top"
        data-visible={showBackToTop}
        onClick={scrollToTop}
        aria-label="Back to top"
        type="button"
      >
        <ArrowUp size={18} />
      </button>
    </main>
  );
}
