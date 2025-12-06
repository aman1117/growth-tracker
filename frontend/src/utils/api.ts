const API_URL = 'https://northern-mariellen-aman1117-e5652442.koyeb.app';
// const API_URL = 'http://localhost:8000';

export const api = {
    async get(endpoint: string) {
        const token = localStorage.getItem('access_token');
        const headers: HeadersInit = {
            'Content-Type': 'application/json',
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const res = await fetch(`${API_URL}${endpoint}`, {
            method: 'GET',
            headers,
        });

        if (res.status === 401) {
            localStorage.removeItem('access_token');
            localStorage.removeItem('username');
            localStorage.removeItem('user_id');
            window.location.href = '/login';
            throw new Error('Unauthorized');
        }

        return res.json();
    },

    async post(endpoint: string, body: any) {
        const token = localStorage.getItem('access_token');
        const headers: HeadersInit = {
            'Content-Type': 'application/json',
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const res = await fetch(`${API_URL}${endpoint}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (res.status === 401) {
            localStorage.removeItem('access_token');
            localStorage.removeItem('username');
            localStorage.removeItem('user_id');
            window.location.href = '/login';
            throw new Error('Unauthorized');
        }

        return res.json();
    },

    async getInsights(username: string) {
        return this.post('/get-insights', { username });
    }
};
