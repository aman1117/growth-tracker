import React, { createContext, useContext, useState, useEffect } from 'react';


interface AuthContextType {
    user: { username: string; id: number } | null;
    login: (token: string, username: string, userId: number) => void;
    logout: () => void;
    isAuthenticated: boolean;
    isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<{ username: string; id: number } | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem('access_token');
        const username = localStorage.getItem('username');
        const userId = localStorage.getItem('user_id');

        if (token && username && userId) {
            setUser({ username, id: parseInt(userId) });
        }
        setIsLoading(false);
    }, []);

    const login = (token: string, username: string, userId: number) => {
        localStorage.setItem('access_token', token);
        localStorage.setItem('username', username);
        localStorage.setItem('user_id', userId.toString());
        setUser({ username, id: userId });
    };

    const logout = () => {
        localStorage.removeItem('access_token');
        localStorage.removeItem('username');
        localStorage.removeItem('user_id');
        setUser(null);
    };

    return (
        <AuthContext.Provider value={{ user, login, logout, isAuthenticated: !!user, isLoading }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};
