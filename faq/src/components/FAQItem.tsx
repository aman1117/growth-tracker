import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { FAQItem as FAQItemType } from '../constants/faq-content.ts';

interface FAQItemProps {
  item: FAQItemType;
  defaultOpen?: boolean;
}

export function FAQItem({ item, defaultOpen = false }: FAQItemProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  // Sync with defaultOpen when search changes
  useEffect(() => {
    setIsOpen(defaultOpen);
  }, [defaultOpen]);

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const triggerId = `faq-trigger-${item.id}`;
  const contentId = `faq-content-${item.id}`;

  return (
    <div className="help-item glass-surface" data-open={isOpen}>
      <h3 style={{ margin: 0, fontSize: 'inherit' }}>
        <button
          id={triggerId}
          className="help-item-trigger"
          onClick={toggle}
          aria-expanded={isOpen}
          aria-controls={contentId}
          type="button"
        >
          <span style={{ flex: 1 }}>{item.question}</span>
          <ChevronDown
            size={18}
            className="help-item-trigger-icon"
            data-open={isOpen}
            aria-hidden="true"
          />
        </button>
      </h3>

      {isOpen && (
        <div
          className="help-item-content"
          id={contentId}
          role="region"
          aria-labelledby={triggerId}
        >
          <p>{item.answer}</p>

          {item.steps && item.steps.length > 0 && (
            <ol className="help-steps">
              {item.steps.map((step, index) => (
                <li key={index} className="help-step">
                  <span className="help-step-number" aria-hidden="true">{index + 1}</span>
                  <div>
                    <div className="help-step-text">{step.text}</div>
                    {step.hint && (
                      <div className="help-step-hint">{step.hint}</div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
