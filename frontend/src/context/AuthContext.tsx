import React, { createContext, useContext, useState, useEffect } from 'react';


interface AuthContextType {
    user: { username: string; id: number; profilePic?: string | null } | null;
    login: (token: string, username: string, userId: number, profilePic?: string | null) => void;
    logout: () => void;
    updateUsername: (newUsername: string) => void;
    updateProfilePic: (url: string | null) => void;
    isAuthenticated: boolean;
    isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<{ username: string; id: number; profilePic?: string | null } | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem('access_token');
        const username = localStorage.getItem('username');
        const userId = localStorage.getItem('user_id');
        const profilePic = localStorage.getItem('profile_pic');

        if (token && username && userId) {
            setUser({ username, id: parseInt(userId), profilePic: profilePic || null });
        }
        setIsLoading(false);
    }, []);

    const login = (token: string, username: string, userId: number, profilePic?: string | null) => {
        localStorage.setItem('access_token', token);
        localStorage.setItem('username', username);
        localStorage.setItem('user_id', userId.toString());
        if (profilePic) {
            localStorage.setItem('profile_pic', profilePic);
        } else {
            localStorage.removeItem('profile_pic');
        }
        setUser({ username, id: userId, profilePic });
    };

    const logout = () => {
        localStorage.removeItem('access_token');
        localStorage.removeItem('username');
        localStorage.removeItem('user_id');
        localStorage.removeItem('profile_pic');
        setUser(null);
    };

    const updateUsername = (newUsername: string) => {
        localStorage.setItem('username', newUsername);
        if (user) {
            setUser({ ...user, username: newUsername });
        }
    };

    const updateProfilePic = (url: string | null) => {
        if (url) {
            localStorage.setItem('profile_pic', url);
        } else {
            localStorage.removeItem('profile_pic');
        }
        if (user) {
            setUser({ ...user, profilePic: url });
        }
    };

    return (
        <AuthContext.Provider value={{ user, login, logout, updateUsername, updateProfilePic, isAuthenticated: !!user, isLoading }}>
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
