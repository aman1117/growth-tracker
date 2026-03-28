export function Footer() {
  return (
    <footer className="help-footer">
      <p>
        Still need help?{' '}
        <a href="mailto:support@trackgrowth.in">
          support@trackgrowth.in
        </a>
      </p>
      <p className="help-footer-copy">
        &copy; {new Date().getFullYear()} Growth Tracker. All rights reserved.
      </p>
    </footer>
  );
}
