import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import { Toast } from './Toast';

export const ForgotPassword: React.FC = () => {
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [isSubmitted, setIsSubmitted] = useState(false);
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        try {
            await api.post('/auth/forgot-password', { email });
            setIsSubmitted(true);
        } catch {
            // Still show success (security: don't reveal if user exists)
            setIsSubmitted(true);
        } finally {
            setLoading(false);
        }
    };

    if (isSubmitted) {
        return (
            <div className="container" style={{ maxWidth: '400px', marginTop: '4rem' }}>
                <div className="card text-center">
                    <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📧</div>
                    <h2 className="mb-4">Check Your Email</h2>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                        If an account exists with <strong>{email}</strong>, we've sent a password reset link.
                    </p>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
                        The link will expire in 15 minutes.
                    </p>
                    <Link to="/login" style={{ textDecoration: 'none' }}>
                        <button className="btn btn-primary">
                            Back to Login
                        </button>
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="container" style={{ maxWidth: '400px', marginTop: '4rem' }}>
            <div className="card">
                <h2 className="text-center mb-4">Forgot Password?</h2>
                <p className="text-center" style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.875rem' }}>
                    Enter your email and we'll send you a reset link
                </p>

                <form onSubmit={handleSubmit}>
                    <div className="input-group">
                        <label className="input-label">Email Address</label>
                        <input
                            type="email"
                            className="input-field"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="Enter your email"
                            required
                        />
                    </div>

                    <button type="submit" className="btn btn-primary" disabled={loading}>
                        {loading ? 'Sending...' : 'Send Reset Link'}
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
