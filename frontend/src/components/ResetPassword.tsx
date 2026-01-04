import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { Loader2, XCircle, CheckCircle } from 'lucide-react';
import { api, ApiError } from '../services/api';
import { SnapToast } from './ui';
import { APP_ROUTES } from '../constants/routes';

export const ResetPassword: React.FC = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const token = searchParams.get('token');

    const [isValidating, setIsValidating] = useState(true);
    const [isValidToken, setIsValidToken] = useState(false);
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
    const [success, setSuccess] = useState(false);

    // Validate token on mount
    useEffect(() => {
        const validateToken = async () => {
            if (!token) {
                setIsValidating(false);
                setIsValidToken(false);
                return;
            }

            try {
                const res = await api.get(`/auth/reset-password/validate?token=${token}`);
                setIsValidToken(res.valid === true);
            } catch {
                setIsValidToken(false);
            } finally {
                setIsValidating(false);
            }
        };

        validateToken();
    }, [token]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (newPassword !== confirmPassword) {
            setToast({ message: 'Passwords do not match', type: 'error' });
            return;
        }

        if (newPassword.length < 8) {
            setToast({ message: 'Password must be at least 8 characters', type: 'error' });
            return;
        }

        setLoading(true);

        try {
            const res = await api.post('/auth/reset-password', {
                token,
                new_password: newPassword,
                confirm_password: confirmPassword
            });

            if (res.success) {
                setSuccess(true);
            } else {
                setToast({ message: res.error || 'Failed to reset password', type: 'error' });
            }
        } catch (err) {
            const message = err instanceof ApiError ? err.message : 'An error occurred. Please try again.';
            setToast({ message, type: 'error' });
        } finally {
            setLoading(false);
        }
    };

    // Loading state
    if (isValidating) {
        return (
            <div className="container" style={{ maxWidth: '320px', marginTop: '2.5rem' }}>
                <div className="card text-center">
                    <div style={{ marginBottom: '0.5rem', display: 'flex', justifyContent: 'center' }}>
                        <Loader2 size={24} color="var(--text-muted)" style={{ animation: 'spin 1s linear infinite' }} />
                    </div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Validating reset link...</p>
                </div>
            </div>
        );
    }

    // Invalid or expired token
    if (!isValidToken) {
        return (
            <div className="container" style={{ maxWidth: '320px', marginTop: '2.5rem' }}>
                <div className="card text-center">
                    <div style={{ marginBottom: '0.5rem', display: 'flex', justifyContent: 'center' }}>
                        <XCircle size={32} color="#ef4444" />
                    </div>
                    <h2 style={{ marginBottom: '0.5rem', fontSize: '1rem' }}>Invalid or Expired Link</h2>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '0.75rem', fontSize: '0.8rem' }}>
                        This reset link is invalid or has expired.
                    </p>
                    <Link to={APP_ROUTES.FORGOT_PASSWORD} style={{ textDecoration: 'none' }}>
                        <button className="btn btn-primary">
                            Request New Link
                        </button>
                    </Link>
                </div>
            </div>
        );
    }

    // Success state
    if (success) {
        return (
            <div className="container" style={{ maxWidth: '320px', marginTop: '2.5rem' }}>
                <div className="card text-center">
                    <div style={{ marginBottom: '0.5rem', display: 'flex', justifyContent: 'center' }}>
                        <CheckCircle size={32} color="#22c55e" />
                    </div>
                    <h2 style={{ marginBottom: '0.5rem', fontSize: '1rem' }}>Password Reset!</h2>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '0.75rem', fontSize: '0.8rem' }}>
                        You can now log in with your new password.
                    </p>
                    <button className="btn btn-primary" onClick={() => navigate(APP_ROUTES.LOGIN)}>
                        Go to Login
                    </button>
                </div>
            </div>
        );
    }

    // Reset form
    return (
        <div className="container" style={{ maxWidth: '320px', marginTop: '2.5rem' }}>
            <div className="card">
                <h2 className="text-center" style={{ marginBottom: '0.35rem', fontSize: '1.1rem' }}>Set New Password</h2>
                <p className="text-center" style={{ color: 'var(--text-secondary)', marginBottom: '0.75rem', fontSize: '0.75rem' }}>
                    Enter your new password below
                </p>

                <form onSubmit={handleSubmit}>
                    <div className="input-group">
                        <label className="input-label">New Password</label>
                        <input
                            type="password"
                            className="input-field"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder="Enter new password"
                            required
                            minLength={8}
                        />
                    </div>

                    <div className="input-group">
                        <label className="input-label">Confirm Password</label>
                        <input
                            type="password"
                            className="input-field"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="Confirm new password"
                            required
                            minLength={8}
                        />
                    </div>

                    <button type="submit" className="btn btn-primary" disabled={loading}>
                        {loading ? 'Resetting...' : 'Reset Password'}
                    </button>
                </form>

                <div style={{ marginTop: '0.5rem', textAlign: 'center' }}>
                    <Link 
                        to={APP_ROUTES.LOGIN}
                        style={{ 
                            fontSize: '0.75rem', 
                            color: 'var(--text-secondary)', 
                            textDecoration: 'none' 
                        }}
                    >
                        ← Back to Login
                    </Link>
                </div>
            </div>
            {toast && (
                <SnapToast
                    message={toast.message}
                    type={toast.type}
                    onClose={() => setToast(null)}
                />
            )}
        </div>
    );
};