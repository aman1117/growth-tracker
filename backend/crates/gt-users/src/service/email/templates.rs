//! Email HTML templates, byte-identical to the Go `fmt.Sprintf` format strings in
//! `internal/services/email.go` (generated from them; one literal per line so trailing spaces
//! survive editors). `%s` takes the next argument and `%%` is a literal `%`.

/// Arguments: username, verify link, verify link, verify link, frontend URL.
pub(super) const VERIFICATION_EMAIL_FORMAT: &str = concat!(
    "\n",
    "<!DOCTYPE html>\n",
    "<html>\n",
    "<head>\n",
    "    <meta charset=\"UTF-8\">\n",
    "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n",
    "</head>\n",
    "<body style=\"margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;\">\n",
    "    <table width=\"100%%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background-color: #f5f5f5; padding: 40px 20px;\">\n",
    "        <tr>\n",
    "            <td align=\"center\">\n",
    "                <table width=\"100%%\" style=\"max-width: 480px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);\">\n",
    "                    <tr>\n",
    "                        <td style=\"padding: 40px 32px;\">\n",
    "                            <div style=\"text-align: center; margin-bottom: 32px;\">\n",
    "                                <h1 style=\"margin: 0; font-size: 24px; font-weight: 700; color: #1a1a1a;\">\n",
    "                                    ✉️ Verify Your Email\n",
    "                                </h1>\n",
    "                            </div>\n",
    "                            \n",
    "                            <p style=\"margin: 0 0 16px; font-size: 16px; color: #333; line-height: 1.5;\">\n",
    "                                Hi <strong>%s</strong>,\n",
    "                            </p>\n",
    "                            <p style=\"margin: 0 0 24px; font-size: 16px; color: #333; line-height: 1.5;\">\n",
    "                                Welcome to Growth Tracker! Please verify your email address by clicking the button below:\n",
    "                            </p>\n",
    "                            \n",
    "                            <div style=\"text-align: center; margin: 32px 0;\">\n",
    "                                <a href=\"%s\" style=\"display: inline-block; padding: 14px 32px; background-color: #22c55e; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 16px; border-radius: 8px;\">\n",
    "                                    Verify Email Address\n",
    "                                </a>\n",
    "                            </div>\n",
    "                            \n",
    "                            <p style=\"margin: 0 0 16px; font-size: 14px; color: #666; line-height: 1.5;\">\n",
    "                                ⏰ This link will expire in <strong>24 hours</strong>.\n",
    "                            </p>\n",
    "                            \n",
    "                            <div style=\"background-color: #f8f9fa; border-radius: 8px; padding: 16px; margin-top: 24px;\">\n",
    "                                <p style=\"margin: 0; font-size: 14px; color: #666; line-height: 1.5;\">\n",
    "                                    If you didn't create an account with Growth Tracker, you can safely ignore this email.\n",
    "                                </p>\n",
    "                            </div>\n",
    "                            \n",
    "                            <p style=\"margin: 24px 0 0; font-size: 12px; color: #999; line-height: 1.5; word-break: break-all;\">\n",
    "                                If the button doesn't work, copy and paste this link into your browser:<br>\n",
    "                                <a href=\"%s\" style=\"color: #22c55e;\">%s</a>\n",
    "                            </p>\n",
    "                        </td>\n",
    "                    </tr>\n",
    "                    \n",
    "                    <tr>\n",
    "                        <td style=\"padding: 24px 32px; border-top: 1px solid #eee; text-align: center;\">\n",
    "                            <p style=\"margin: 0; font-size: 12px; color: #999;\">\n",
    "                                <a href=\"%s\" style=\"color: #22c55e; text-decoration: none;\">Growth Tracker</a> • Track your daily activities\n",
    "                            </p>\n",
    "                        </td>\n",
    "                    </tr>\n",
    "                </table>\n",
    "            </td>\n",
    "        </tr>\n",
    "    </table>\n",
    "</body>\n",
    "</html>\n",
);

/// Arguments: username, reset link, reset link, reset link, frontend URL.
pub(super) const PASSWORD_RESET_EMAIL_FORMAT: &str = concat!(
    "\n",
    "<!DOCTYPE html>\n",
    "<html>\n",
    "<head>\n",
    "    <meta charset=\"UTF-8\">\n",
    "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n",
    "</head>\n",
    "<body style=\"margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;\">\n",
    "    <table width=\"100%%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background-color: #f5f5f5; padding: 40px 20px;\">\n",
    "        <tr>\n",
    "            <td align=\"center\">\n",
    "                <table width=\"100%%\" style=\"max-width: 480px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);\">\n",
    "                    <tr>\n",
    "                        <td style=\"padding: 40px 32px;\">\n",
    "                            <div style=\"text-align: center; margin-bottom: 32px;\">\n",
    "                                <h1 style=\"margin: 0; font-size: 24px; font-weight: 700; color: #1a1a1a;\">\n",
    "                                    🔐 Password Reset\n",
    "                                </h1>\n",
    "                            </div>\n",
    "                            \n",
    "                            <p style=\"margin: 0 0 16px; font-size: 16px; color: #333; line-height: 1.5;\">\n",
    "                                Hi <strong>%s</strong>,\n",
    "                            </p>\n",
    "                            <p style=\"margin: 0 0 24px; font-size: 16px; color: #333; line-height: 1.5;\">\n",
    "                                We received a request to reset your password for your Growth Tracker account. Click the button below to set a new password:\n",
    "                            </p>\n",
    "                            \n",
    "                            <div style=\"text-align: center; margin: 32px 0;\">\n",
    "                                <a href=\"%s\" style=\"display: inline-block; padding: 14px 32px; background-color: #0066ff; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 16px; border-radius: 8px;\">\n",
    "                                    Reset Password\n",
    "                                </a>\n",
    "                            </div>\n",
    "                            \n",
    "                            <p style=\"margin: 0 0 16px; font-size: 14px; color: #666; line-height: 1.5;\">\n",
    "                                ⏰ This link will expire in <strong>15 minutes</strong>.\n",
    "                            </p>\n",
    "                            \n",
    "                            <div style=\"background-color: #f8f9fa; border-radius: 8px; padding: 16px; margin-top: 24px;\">\n",
    "                                <p style=\"margin: 0; font-size: 14px; color: #666; line-height: 1.5;\">\n",
    "                                    If you didn't request this password reset, you can safely ignore this email. Your password will remain unchanged.\n",
    "                                </p>\n",
    "                            </div>\n",
    "                            \n",
    "                            <p style=\"margin: 24px 0 0; font-size: 12px; color: #999; line-height: 1.5; word-break: break-all;\">\n",
    "                                If the button doesn't work, copy and paste this link into your browser:<br>\n",
    "                                <a href=\"%s\" style=\"color: #0066ff;\">%s</a>\n",
    "                            </p>\n",
    "                        </td>\n",
    "                    </tr>\n",
    "                    \n",
    "                    <tr>\n",
    "                        <td style=\"padding: 24px 32px; border-top: 1px solid #eee; text-align: center;\">\n",
    "                            <p style=\"margin: 0; font-size: 12px; color: #999;\">\n",
    "                                <a href=\"%s\" style=\"color: #0066ff; text-decoration: none;\">Growth Tracker</a> • Track your daily activities\n",
    "                            </p>\n",
    "                        </td>\n",
    "                    </tr>\n",
    "                </table>\n",
    "            </td>\n",
    "        </tr>\n",
    "    </table>\n",
    "</body>\n",
    "</html>\n",
);

/// Go `fmt.Sprintf` for format strings that only use `%s` and `%%`. Missing arguments render as
/// `%!s(MISSING)`, like Go.
pub(super) fn sprintf_s(format: &str, args: &[&str]) -> String {
    let extra: usize = args.iter().map(|a| a.len()).sum();
    let mut out = String::with_capacity(format.len() + extra);
    let mut args = args.iter();
    let mut rest = format;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        if let Some(tail) = after.strip_prefix('%') {
            out.push('%');
            rest = tail;
        } else if let Some(tail) = after.strip_prefix('s') {
            out.push_str(args.next().copied().unwrap_or("%!s(MISSING)"));
            rest = tail;
        } else {
            out.push('%');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}
