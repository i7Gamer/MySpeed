import "./styles.sass";
import Button from "@/common/components/Button/index.js";
import {faHome, faPaperPlane, faCheckCircle, faInfoCircle} from "@fortawesome/free-solid-svg-icons";
import {useState} from "react";
import {useLocation, useNavigate} from "react-router-dom";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";

export const TutorialSubmission = () => {
    const location = useLocation();
    const navigate = useNavigate();

    const typeParam = new URLSearchParams(location.search).get("type");

    const [type, setType] = useState(typeParam || "video");
    const [email, setEmail] = useState("");
    const [contentUrl, setContentUrl] = useState("");
    const [message, setMessage] = useState("");
    const [success, setSuccess] = useState(false);
    const [agreed, setAgreed] = useState(false);
    const [failed, setFailed] = useState(false);

    const postTutorial = async (ev) => {
        ev.preventDefault();
        setFailed(false);

        try {
            const response = await fetch("https://api.staticforms.xyz/submit", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    email: email, message: message, $type: type, $contentUrl: contentUrl,
                    accessKey: "b2823f24-eaf7-467f-ae28-0eb350385cdd"
                })
            });

            // Previously fell back to a mailto: pointing at the upstream author's
            // personal inbox. Surface the failure instead of handing the
            // submission to a third party.
            setFailed(!response.ok);
            setSuccess(response.ok);
        } catch {
            setFailed(true);
        }
    }

    if (success) {
        return (
            <div className="submission-page">
                <div className="success-state">
                    <div className="success-icon">
                        <FontAwesomeIcon icon={faCheckCircle}/>
                    </div>
                    <h1>Submission Received</h1>
                    <p>Thank you for your contribution! We'll review your {type} and get back to you soon.</p>
                    <Button 
                        icon={faHome} 
                        text="Back to Home" 
                        color="primary"
                        onClick={() => navigate("/")}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="submission-page">
            <div className="submission-container">
                <div className="submission-header">
                    <h1>Submit a Tutorial</h1>
                    <p>Share your MySpeed content with the community</p>
                </div>

                <div className="submission-content">
                    <form className="submission-form" onSubmit={postTutorial}>
                        <input type="hidden" name="honeypot" style={{display: "none"}}/>

                        {failed && (
                            <div className="submission-error">
                                <FontAwesomeIcon icon={faInfoCircle}/>
                                <span>We couldn't send your submission. Please try again in a moment.</span>
                            </div>
                        )}

                        <div className="form-group">
                            <label htmlFor="type">Content Type</label>
                            <select 
                                id="type" 
                                value={type} 
                                onChange={(e) => setType(e.target.value)}
                            >
                                <option value="video">Video</option>
                                <option value="blog">Blog Post</option>
                            </select>
                        </div>

                        <div className="form-group">
                            <label htmlFor="email">Email Address</label>
                            <input 
                                type="email" 
                                id="email" 
                                value={email} 
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="your@email.com"
                                required
                            />
                        </div>

                        <div className="form-group">
                            <label htmlFor="content-url">Content URL</label>
                            <input 
                                type="url" 
                                id="content-url" 
                                value={contentUrl}
                                onChange={(e) => setContentUrl(e.target.value)}
                                placeholder={type === "blog" ? "https://example.com/your-blog-post" : "https://youtube.com/watch?v=..."}
                                required
                            />
                        </div>

                        <div className="form-group">
                            <label htmlFor="message">Additional Notes <span className="optional">(optional)</span></label>
                            <textarea 
                                id="message" 
                                value={message} 
                                onChange={(e) => setMessage(e.target.value)}
                                placeholder="Anything you'd like us to know?"
                                rows={4}
                            />
                        </div>

                        <div className="form-checkbox">
                            <input 
                                type="checkbox" 
                                id="terms" 
                                checked={agreed}
                                onChange={(e) => setAgreed(e.target.checked)}
                                required
                            />
                            <label htmlFor="terms">I confirm this is my original content and follows the guidelines</label>
                        </div>

                        <Button 
                            icon={faPaperPlane} 
                            text="Submit Tutorial" 
                            color="primary"
                            size="lg"
                            disabled={!agreed}
                        />
                    </form>

                    <aside className="guidelines">
                        <div className="guidelines-header">
                            <FontAwesomeIcon icon={faInfoCircle}/>
                            <h3>Submission Guidelines</h3>
                        </div>
                        
                        <ul>
                            <li>Provide a valid email address for follow-up communication</li>
                            <li>Content must be publicly accessible</li>
                            <li>Must be related to MySpeed (tutorial, review, guide, etc.)</li>
                            <li>You must be the original creator of the content</li>
                        </ul>
                    </aside>
                </div>
            </div>
        </div>
    );
}
