import React from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { LogOut, TrendingUp } from 'lucide-react';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    const handleLogout = () => {
        logout();
        navigate('/login');
    };

    return (
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
            <header style={{
                borderBottom: '1px solid var(--border)',
                padding: '0.75rem 0',
                backgroundColor: 'rgba(255, 255, 255, 0.8)', // Semi-transparent
                backdropFilter: 'blur(12px)', // Glassmorphism
                WebkitBackdropFilter: 'blur(12px)',
                position: 'sticky',
                top: 0,
                zIndex: 50
            }}>
                <div className="container" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <div style={{
                            background: 'var(--text-primary)',
                            color: 'white',
                            padding: '0.25rem',
                            borderRadius: '6px', // Slight radius for logo icon looks better
                            display: 'flex'
                        }}>
                            <TrendingUp size={20} strokeWidth={2.5} />
                        </div>
                        <h1 style={{
                            fontSize: '1.125rem',
                            fontWeight: 700,
                            color: 'var(--text-primary)',
                            letterSpacing: '-0.025em'
                        }}>
                            Growth Tracker
                        </h1>
                    </div>

                    {user && (
                        <div className="flex items-center gap-8">
                            <span style={{
                                fontSize: '1rem',
                                marginRight: '0.5rem',
                                fontWeight: 700,
                                color: 'var(--text-primary)'
                            }}>
                                {user.username}
                            </span>
                            <button
                                onClick={handleLogout}
                                className="btn-outline"
                                style={{
                                    padding: '0.5rem',
                                    border: '1px solid var(--border)',
                                    borderRadius: '50%', // Circle
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: 'var(--text-secondary)',
                                    width: '36px',
                                    height: '36px'
                                }}
                            >
                                <LogOut size={16} />
                            </button>
                        </div>
                    )}
                </div>
            </header>
            <main style={{ flex: 1, paddingTop: '0.5rem' }}>
                {children}
            </main>
        </div>
    );
};
