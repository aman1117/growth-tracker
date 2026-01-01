import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../utils/api';
import { Toast } from './Toast';

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
        } catch {
            setToast({ message: 'An error occurred. Please try again.', type: 'error' });
        } finally {
            setLoading(false);
        }
    };

    // Loading state
    if (isValidating) {
        return (
            <div className="container" style={{ maxWidth: '400px', marginTop: '4rem' }}>
                <div className="card text-center">
                    <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>⏳</div>
                    <p style={{ color: 'var(--text-secondary)' }}>Validating reset link...</p>
                </div>
            </div>
        );
    }

    // Invalid or expired token
    if (!isValidToken) {
        return (
            <div className="container" style={{ maxWidth: '400px', marginTop: '4rem' }}>
                <div className="card text-center">
                    <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>❌</div>
                    <h2 className="mb-4">Invalid or Expired Link</h2>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                        This password reset link is invalid or has expired. Please request a new one.
                    </p>
                    <Link to="/forgot-password" style={{ textDecoration: 'none' }}>
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
            <div className="container" style={{ maxWidth: '400px', marginTop: '4rem' }}>
                <div className="card text-center">
                    <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✅</div>
                    <h2 className="mb-4">Password Reset Successful!</h2>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                        Your password has been updated. You can now log in with your new password.
                    </p>
                    <button className="btn btn-primary" onClick={() => navigate('/login')}>
                        Go to Login
                    </button>
                </div>
            </div>
        );
    }

    // Reset form
    return (
        <div className="container" style={{ maxWidth: '400px', marginTop: '4rem' }}>
            <div className="card">
                <h2 className="text-center mb-4">Set New Password</h2>
                <p className="text-center" style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.875rem' }}>
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

                <div className="mt-4 text-center">
                    <Link 
                        to="/login"
                        style={{ 
                            fontSize: '0.875rem', 
                            color: 'var(--text-secondary)', 
                            textDecoration: 'none' 
                        }}
                    >
                        ← Back to Login
                    </Link>
                </div>
            </div>
            {toast && (
                <Toast
                    message={toast.message}
                    type={toast.type}
                    onClose={() => setToast(null)}
                />
            )}
        </div>
    );
};