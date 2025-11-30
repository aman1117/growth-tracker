import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../utils/api';
import { useNavigate } from 'react-router-dom';

export const AuthForm: React.FC = () => {
    const [isLogin, setIsLogin] = useState(true);
    const [email, setEmail] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const { login } = useAuth();
    const navigate = useNavigate();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            if (isLogin) {
                // Login
                const res = await api.post('/login', { identifier: username, password });
                if (res.success) {
                    // We need user_id, but login response doesn't return it directly in the root sometimes?
                    // Let's check backend code.
                    // LoginHandler returns: access_token, token_type, expires_at, expires_in.
                    // It DOES NOT return user_id or username directly.
                    // But we can decode the token or call a protected endpoint.
                    // The plan said "Register successful we should also call login".
                    // Let's assume we need to fetch user details after login or decode token.
                    // Wait, the backend `AuthMiddleware` sets locals from token claims.
                    // `ProtectedHandler` returns user_id and username.
                    // So after login, we should call a protected endpoint to get user details?
                    // Or we can just decode the token if it's a JWT.
                    // Let's try calling a protected endpoint /protected (if it exists) or just /get-activities?
                    // The backend has `ProtectedHandler` but it's not bound to a route in `main.go`?
                    // Let's check `main.go`.
                    // `app.Post("/create-activity", ...)`
                    // `app.Post("/get-activities", ...)`
                    // There is NO generic protected endpoint exposed in `main.go`.
                    // However, `services.LoginHandler` returns `access_token`.
                    // The token claims likely have the data.
                    // I'll add a helper to parse JWT payload to get username/id without a library if possible, or just use `atob`.

                    const token = res.access_token;
                    const payload = JSON.parse(atob(token.split('.')[1]));
                    // Payload should have user_id and username based on `utils.GenerateToken`.

                    login(token, payload.username, payload.user_id);
                    navigate('/');
                } else {
                    setError(res.error || 'Login failed');
                }
            } else {
                // Register
                const res = await api.post('/register', { email, username, password });
                if (res.success) {
                    // Auto login
                    const loginRes = await api.post('/login', { identifier: username, password });
                    if (loginRes.success) {
                        const token = loginRes.access_token;
                        const payload = JSON.parse(atob(token.split('.')[1]));
                        login(token, payload.username, payload.user_id);
                        navigate('/');
                    } else {
                        setIsLogin(true);
                        setError('Registration successful, please login.');
                    }
                } else {
                    setError(res.error || 'Registration failed');
                }
            }
        } catch (err) {
            setError('An error occurred. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="container" style={{ maxWidth: '400px', marginTop: '4rem' }}>
            <div className="card">
                <h2 className="text-center mb-4">{isLogin ? 'Welcome Back' : 'Create Account'}</h2>

                {error && (
                    <div style={{ color: 'var(--error)', marginBottom: '1rem', fontSize: '0.875rem', textAlign: 'center' }}>
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit}>
                    {!isLogin && (
                        <div className="input-group">
                            <label className="input-label">Email</label>
                            <input
                                type="email"
                                className="input-field"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                            />
                        </div>
                    )}

                    <div className="input-group">
                        <label className="input-label">Username</label>
                        <input
                            type="text"
                            className="input-field"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            required
                        />
                    </div>

                    <div className="input-group">
                        <label className="input-label">Password</label>
                        <input
                            type="password"
                            className="input-field"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            minLength={8}
                        />
                    </div>

                    <button type="submit" className="btn btn-primary" disabled={loading}>
                        {loading ? 'Processing...' : (isLogin ? 'Login' : 'Register')}
                    </button>
                </form>

                <div className="mt-4 text-center">
                    <button
                        className="btn-outline"
                        style={{ border: 'none', fontSize: '0.875rem', color: 'var(--text-secondary)' }}
                        onClick={() => {
                            setIsLogin(!isLogin);
                            setError('');
                        }}
                    >
                        {isLogin ? "Don't have an account? Register" : "Already have an account? Login"}
                    </button>
                </div>
            </div>
        </div>
    );
};
