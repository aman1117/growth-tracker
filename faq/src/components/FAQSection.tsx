import type { FAQCategory } from '../constants/faq-content.ts';

import { FAQItem } from './FAQItem.tsx';

interface FAQSectionProps {
  category: FAQCategory;
  /** When set, auto-expand items whose id matches */
  expandedItemIds?: Set<string>;
}

export function FAQSection({ category, expandedItemIds }: FAQSectionProps) {
  const Icon = category.icon;

  return (
    <section className="help-section" id={`section-${category.id}`}>
      <div className="help-section-header">
        <div
          className="help-section-icon"
          style={{
            background: category.iconBg,
            color: category.iconColor,
          }}
        >
          <Icon size={20} />
        </div>
        <div>
          <h2 className="help-section-title">{category.label}</h2>
          <span className="help-section-count">
            {category.items.length} {category.items.length === 1 ? 'question' : 'questions'}
          </span>
        </div>
      </div>

      {category.items.map((item) => (
        <FAQItem
          key={item.id}
          item={item}
          defaultOpen={expandedItemIds?.has(item.id)}
        />
      ))}
    </section>
  );
}
