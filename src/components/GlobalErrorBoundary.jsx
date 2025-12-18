import React from 'react';

export class GlobalErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, errorInfo) {
        console.error("Global Error Caught:", error, errorInfo);
        this.setState({ errorInfo });
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    padding: '2rem',
                    fontFamily: 'sans-serif',
                    backgroundColor: '#fff0f0',
                    height: '100vh',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#c00'
                }}>
                    <h1>Something went wrong.</h1>
                    <p>The application crashed.</p>
                    <pre style={{
                        marginTop: '1rem',
                        padding: '1rem',
                        backgroundColor: '#fff',
                        border: '1px solid #c00',
                        borderRadius: '4px',
                        maxWidth: '800px',
                        overflow: 'auto',
                        textAlign: 'left'
                    }}>
                        {this.state.error && this.state.error.toString()}
                        <br />
                        {this.state.errorInfo && this.state.errorInfo.componentStack}
                    </pre>
                    <button
                        onClick={() => window.location.reload()}
                        style={{
                            marginTop: '2rem',
                            padding: '0.5rem 1rem',
                            fontSize: '1rem',
                            backgroundColor: '#c00',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer'
                        }}
                    >
                        Reload Application
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
